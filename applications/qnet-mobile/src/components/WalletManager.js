import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import 'react-native-get-random-values'; // Must be imported first — polyfills crypto.getRandomValues
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { shake256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_256 as sha3Hex } from 'js-sha3';
import {
  smtFold, accountLeafHash, addressKeyHash, readCertifiedAccount, readCertifiedToken, isLegacyProofBody,
} from '../crypto/SmtFold'; // pure; shared with the jest proof pin and the extension
import { Keypair } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl'; // Ed25519 signing for node operations
import * as Keychain from 'react-native-keychain';
import {
  EXPLORER_API, GENESIS_NODES, SOLANA_CLUSTER, getSolanaRpcUrl, rotateSolanaRpc, shuffledGenesisNodes,
} from '../config/nodes';
// Post-quantum BFT light-client: trustless committee-QC state-root verification
// (replaces the MITM-bypassable 2/3 peer-poll). MITM-proof at any network size.
import {
  certifiedStateRootIndex, verifyLogInclusion, verifyLogWindowInclusion, verifyMacroblockLogsRoot, transferLogLeaf,
  highestVerifiedIndex, exportVerifiedAnchors, importVerifiedAnchors, chainIdentity, isRateLimitBody,
  certifiedStateRootAt, certifiedHeadHint, markNodeOld, nodeMarkedOld, trustFloorIndex,
} from '../crypto/QcLightClient';
import {
  agreedEndpoints, mergeEndpoints, readPoolUrls, loadDiscovered, saveDiscovered, DISCOVERY_INTERVAL_MS,
  MIN_GENESIS_AGREEMENT,
} from '../services/NodePool';
import {
  planNonce, pendingFor, pendingEntry, settle, putSigned, updateEntry, pendingChoices, recentSettled, bodyHashOf,
  pendingView, stoppable, stopLandsUntil, stopFrom, stoppedUntil, autoSendable, refusalHeals, mayLandUntil,
  RESEND_HELD_MS, normalSpend, ownSpends, spendableFrom,
} from '../services/PendingTx';
import { parseStrictJson, u64Text } from '../utils/strictJson';
import { txLookupState } from '../utils/txHistory';

// Canonical identity + signed-preimage construction, pinned cross-language against the node and the
// extension by __tests__/fix5_kat.test.js.
import {
  QNET_CHAIN_TAG, walletSeedString, eonFromPublicKeyBytes, transferPreimage, contractCallPreimage, contractDeployPreimage,
} from '../crypto/WalletIdentity';
// Calldata, gas and request bodies: the one copy the extension and the SDK compile too (tx-vectors.json).
import {
  contractCallData, contractCallIntrinsicGas, contractCallRequestJson, transferRequestJson, toU64String, TX_ROUTES,
  buildContractCall as buildWasmCall,
} from '../crypto/TxBuilders';
import { nodeReservationMessage, signOffchainMessage, signSiteRecord } from '../crypto/OffchainMessage';
import { base58Encode, fromBaseUnits, messageFeePayer, PACKET_DATA_SIZE } from '../crypto/SolanaTx';
import { SOLANA_TOKENS, heldTokenBase } from '../services/SolanaSend';
import {
  attachPreimage, b64url, consentPreimage, delegationPreimage, lightNodeId, ownerBindPreimage, registrationProof,
  statusPreimage, walletUnbindPreimage,
} from '../crypto/NodePreimages';
import {
  GAS_PRICE, TRANSFER_GAS_LIMIT, STORAGE_DEPOSIT_NANO, DEPLOY_GAS_PRICE, DEPLOY_GAS_LIMIT, feeNano, NANO_PER_QNC,
} from '../config/fees';
import {
  isVaultV4, createVault, unwrapWithPassword, unwrapWithBio, openPayload, sealPayload, rewrapPassword,
  withBioWrap, withoutBioWrap, sealRecord, openRecord, aesKey, randomBytes, DeviceKeyError, VaultFormatError,
  withMnemonic, openMnemonic, resealDeviceWrap, DEK_BYTES,
} from '../crypto/Vault';
import { PASSWORD_MIN_LENGTH, passwordTooShort } from '../crypto/PasswordStrength';
import {
  deviceSealer, deviceSealerFor, biometricSealer, biometricKeyAvailable, bootClock, deleteDeviceKeys,
  deleteBiometricKey, deleteLegacyDeviceKey, isCurrentDeviceSealer, LEGACY_DEVICE_SEALER, clearSecretCopy, clearBrowserData,
} from '../services/DeviceSecurity';
import {
  availability as deviceAuthStoreAvailability, write as writeDeviceAuth, read as readDeviceAuth, remove as removeDeviceAuth,
  state as deviceAuthStoreState,
} from '../services/DeviceAuthStore';
import { forgetKeys as forgetNodeDeviceKeys } from '../services/NodeDeviceKey';
import { createPasswordLimiter } from '../utils/passwordLimiter';
import logger from '../utils/logger';
import { tr } from '../i18n';

/** Both copies of the vault are unreadable: nothing is deleted, the screen offers the recovery phrase. */
export class VaultCorruptError extends Error {
  constructor() {
    super('The wallet data on this device cannot be read');
    this.name = 'VaultCorruptError';
    this.code = 'vault_corrupt';
    this.uncounted = true; // says nothing about the password
  }
}

// The open session is an opaque object keyed by this symbol, never a string (MVA-R4-03): a typed password is always a
// string, so no password can ever be taken for a session token, and no token can be typed.
const SESSION_CRED = Symbol('qnet.session');
// iOS: a credential that stands for "the vault secret, behind a fresh Face ID / Touch ID / passcode check". The
// screen passes it where a password goes; only this module reads the Keychain item it names (MVA-R3-03).
const DEVICE_AUTH_CRED = Symbol('qnet.deviceAuthCredential');
const LIMITER_SERVICE = 'qnet_pw_limiter';
const LIMITER_MARK_KEY = 'qnet_pw_limiter_counted';
const IOS_NOT_NOW_CODE = '-25308'; // errSecInteractionNotAllowed
const KEYCHAIN_GROUP_MOVED_KEY = 'qnet_kc_group_v2';

export class WalletManager {
  constructor() {
    // The unlocked session: the vault's data key as a non-extractable CryptoKey, reached through an opaque
    // token. The screen holds the token, never the password; lockSession drops both.
    this._session = null;       // { token, dekKey, vaultId }
    this._walletGen = 0;        // bumped whenever the wallet on this device changes
    this._txLane = Promise.resolve(); // nonce-bound transactions are signed and sent one at a time
    this._headHint = null;      // { idx, at }: the chain head a genesis node last reported
    this._limiter = createPasswordLimiter({
      load: async () => {
        let item;
        try {
          item = await Keychain.getGenericPassword({ service: LIMITER_SERVICE });
        } catch (e) {
          // iOS refused the read only for now (the phone is locked, the app woke in the background): no answer, so
          // nothing is kept and the next check reads again. Any other refusal counts as unreadable.
          if (Platform.OS === 'ios' && String((e && e.code) || '') === IOS_NOT_NOW_CODE) {
            throw Object.assign(new Error('The lockout state cannot be read right now'), { notNow: true });
          }
          throw e;
        }
        if (item && item.password) return JSON.parse(item.password);
        // No item, yet failures were recorded: a write replaces the item by deleting it first (iOS), so one that
        // failed half way leaves none. That reads as unreadable (the most failures), never as a clean slate.
        if ((await AsyncStorage.getItem(LIMITER_MARK_KEY)) === '1') throw new Error('The lockout state is missing');
        return null;
      },
      save: async (state) => {
        const counted = state.failures > 0 || state.lockMs > 0;
        if (counted) await AsyncStorage.setItem(LIMITER_MARK_KEY, '1');
        await Keychain.setGenericPassword('lockout', JSON.stringify(state), {
          service: LIMITER_SERVICE,
          accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        if (!counted) await AsyncStorage.removeItem(LIMITER_MARK_KEY);
      },
      clock: bootClock,
    });
    this._limiterSeeded = false;

    // The recovery-phrase word list (2048 words)
    this.BIP39_WORDLIST = [
      "abandon",
      "ability",
      "able",
      "about",
      "above",
      "absent",
      "absorb",
      "abstract",
      "absurd",
      "abuse",
      "access",
      "accident",
      "account",
      "accuse",
      "achieve",
      "acid",
      "acoustic",
      "acquire",
      "across",
      "act",
      "action",
      "actor",
      "actress",
      "actual",
      "adapt",
      "add",
      "addict",
      "address",
      "adjust",
      "admit",
      "adult",
      "advance",
      "advice",
      "aerobic",
      "affair",
      "afford",
      "afraid",
      "again",
      "age",
      "agent",
      "agree",
      "ahead",
      "aim",
      "air",
      "airport",
      "aisle",
      "alarm",
      "album",
      "alcohol",
      "alert",
      "alien",
      "all",
      "alley",
      "allow",
      "almost",
      "alone",
      "alpha",
      "already",
      "also",
      "alter",
      "always",
      "amateur",
      "amazing",
      "among",
      "amount",
      "amused",
      "analyst",
      "anchor",
      "ancient",
      "anger",
      "angle",
      "angry",
      "animal",
      "ankle",
      "announce",
      "annual",
      "another",
      "answer",
      "antenna",
      "antique",
      "anxiety",
      "any",
      "apart",
      "apology",
      "appear",
      "apple",
      "approve",
      "april",
      "arch",
      "arctic",
      "area",
      "arena",
      "argue",
      "arm",
      "armed",
      "armor",
      "army",
      "around",
      "arrange",
      "arrest",
      "arrive",
      "arrow",
      "art",
      "artefact",
      "artist",
      "artwork",
      "ask",
      "aspect",
      "assault",
      "asset",
      "assist",
      "assume",
      "asthma",
      "athlete",
      "atom",
      "attack",
      "attend",
      "attitude",
      "attract",
      "auction",
      "audit",
      "august",
      "aunt",
      "author",
      "auto",
      "autumn",
      "average",
      "avocado",
      "avoid",
      "awake",
      "aware",
      "away",
      "awesome",
      "awful",
      "awkward",
      "axis",
      "baby",
      "bachelor",
      "bacon",
      "badge",
      "bag",
      "balance",
      "balcony",
      "ball",
      "bamboo",
      "banana",
      "banner",
      "bar",
      "barely",
      "bargain",
      "barrel",
      "base",
      "basic",
      "basket",
      "battle",
      "beach",
      "bean",
      "beauty",
      "because",
      "become",
      "beef",
      "before",
      "begin",
      "behave",
      "behind",
      "believe",
      "below",
      "belt",
      "bench",
      "benefit",
      "best",
      "betray",
      "better",
      "between",
      "beyond",
      "bicycle",
      "bid",
      "bike",
      "bind",
      "biology",
      "bird",
      "birth",
      "bitter",
      "black",
      "blade",
      "blame",
      "blanket",
      "blast",
      "bleak",
      "bless",
      "blind",
      "blood",
      "blossom",
      "blouse",
      "blue",
      "blur",
      "blush",
      "board",
      "boat",
      "body",
      "boil",
      "bomb",
      "bone",
      "bonus",
      "book",
      "boost",
      "border",
      "boring",
      "borrow",
      "boss",
      "bottom",
      "bounce",
      "box",
      "boy",
      "bracket",
      "brain",
      "brand",
      "brass",
      "brave",
      "bread",
      "breeze",
      "brick",
      "bridge",
      "brief",
      "bright",
      "bring",
      "brisk",
      "broccoli",
      "broken",
      "bronze",
      "broom",
      "brother",
      "brown",
      "brush",
      "bubble",
      "buddy",
      "budget",
      "buffalo",
      "build",
      "bulb",
      "bulk",
      "bullet",
      "bundle",
      "bunker",
      "burden",
      "burger",
      "burst",
      "bus",
      "business",
      "busy",
      "butter",
      "buyer",
      "buzz",
      "cabbage",
      "cabin",
      "cable",
      "cactus",
      "cage",
      "cake",
      "call",
      "calm",
      "camera",
      "camp",
      "can",
      "canal",
      "cancel",
      "candy",
      "cannon",
      "canoe",
      "canvas",
      "canyon",
      "capable",
      "capital",
      "captain",
      "car",
      "carbon",
      "card",
      "cargo",
      "carpet",
      "carry",
      "cart",
      "case",
      "cash",
      "casino",
      "castle",
      "casual",
      "cat",
      "catalog",
      "catch",
      "category",
      "cattle",
      "caught",
      "cause",
      "caution",
      "cave",
      "ceiling",
      "celery",
      "cement",
      "census",
      "century",
      "cereal",
      "certain",
      "chair",
      "chalk",
      "champion",
      "change",
      "chaos",
      "chapter",
      "charge",
      "chase",
      "chat",
      "cheap",
      "check",
      "cheese",
      "chef",
      "cherry",
      "chest",
      "chicken",
      "chief",
      "child",
      "chimney",
      "choice",
      "choose",
      "chronic",
      "chuckle",
      "chunk",
      "churn",
      "cigar",
      "cinnamon",
      "circle",
      "citizen",
      "city",
      "civil",
      "claim",
      "clap",
      "clarify",
      "claw",
      "clay",
      "clean",
      "clerk",
      "clever",
      "click",
      "client",
      "cliff",
      "climb",
      "clinic",
      "clip",
      "clock",
      "clog",
      "close",
      "cloth",
      "cloud",
      "clown",
      "club",
      "clump",
      "cluster",
      "clutch",
      "coach",
      "coast",
      "coconut",
      "code",
      "coffee",
      "coil",
      "coin",
      "collect",
      "color",
      "column",
      "combine",
      "come",
      "comfort",
      "comic",
      "common",
      "company",
      "concert",
      "conduct",
      "confirm",
      "congress",
      "connect",
      "consider",
      "control",
      "convince",
      "cook",
      "cool",
      "copper",
      "copy",
      "coral",
      "core",
      "corn",
      "correct",
      "cost",
      "cotton",
      "couch",
      "country",
      "couple",
      "course",
      "cousin",
      "cover",
      "coyote",
      "crack",
      "cradle",
      "craft",
      "cram",
      "crane",
      "crash",
      "crater",
      "crawl",
      "crazy",
      "cream",
      "credit",
      "creek",
      "crew",
      "cricket",
      "crime",
      "crisp",
      "critic",
      "crop",
      "cross",
      "crouch",
      "crowd",
      "crucial",
      "cruel",
      "cruise",
      "crumble",
      "crunch",
      "crush",
      "cry",
      "crystal",
      "cube",
      "culture",
      "cup",
      "cupboard",
      "curious",
      "current",
      "curtain",
      "curve",
      "cushion",
      "custom",
      "cute",
      "cycle",
      "dad",
      "damage",
      "damp",
      "dance",
      "danger",
      "daring",
      "dash",
      "daughter",
      "dawn",
      "day",
      "deal",
      "debate",
      "debris",
      "decade",
      "december",
      "decide",
      "decline",
      "decorate",
      "decrease",
      "deer",
      "defense",
      "define",
      "defy",
      "degree",
      "delay",
      "deliver",
      "demand",
      "demise",
      "denial",
      "dentist",
      "deny",
      "depart",
      "depend",
      "deposit",
      "depth",
      "deputy",
      "derive",
      "describe",
      "desert",
      "design",
      "desk",
      "despair",
      "destroy",
      "detail",
      "detect",
      "develop",
      "device",
      "devote",
      "diagram",
      "dial",
      "diamond",
      "diary",
      "dice",
      "diesel",
      "diet",
      "differ",
      "digital",
      "dignity",
      "dilemma",
      "dinner",
      "dinosaur",
      "direct",
      "dirt",
      "disagree",
      "discover",
      "disease",
      "dish",
      "dismiss",
      "disorder",
      "display",
      "distance",
      "divert",
      "divide",
      "divorce",
      "dizzy",
      "doctor",
      "document",
      "dog",
      "doll",
      "dolphin",
      "domain",
      "donate",
      "donkey",
      "donor",
      "door",
      "dose",
      "double",
      "dove",
      "draft",
      "dragon",
      "drama",
      "drastic",
      "draw",
      "dream",
      "dress",
      "drift",
      "drill",
      "drink",
      "drip",
      "drive",
      "drop",
      "drum",
      "dry",
      "duck",
      "dumb",
      "dune",
      "during",
      "dust",
      "dutch",
      "duty",
      "dwarf",
      "dynamic",
      "eager",
      "eagle",
      "early",
      "earn",
      "earth",
      "easily",
      "east",
      "easy",
      "echo",
      "ecology",
      "economy",
      "edge",
      "edit",
      "educate",
      "effort",
      "egg",
      "eight",
      "either",
      "elbow",
      "elder",
      "electric",
      "elegant",
      "element",
      "elephant",
      "elevator",
      "elite",
      "else",
      "embark",
      "embody",
      "embrace",
      "emerge",
      "emotion",
      "employ",
      "empower",
      "empty",
      "enable",
      "enact",
      "end",
      "endless",
      "endorse",
      "enemy",
      "energy",
      "enforce",
      "engage",
      "engine",
      "enhance",
      "enjoy",
      "enlist",
      "enough",
      "enrich",
      "enroll",
      "ensure",
      "enter",
      "entire",
      "entry",
      "envelope",
      "episode",
      "equal",
      "equip",
      "era",
      "erase",
      "erode",
      "erosion",
      "error",
      "erupt",
      "escape",
      "essay",
      "essence",
      "estate",
      "eternal",
      "ethics",
      "evidence",
      "evil",
      "evoke",
      "evolve",
      "exact",
      "example",
      "excess",
      "exchange",
      "excite",
      "exclude",
      "excuse",
      "execute",
      "exercise",
      "exhaust",
      "exhibit",
      "exile",
      "exist",
      "exit",
      "exotic",
      "expand",
      "expect",
      "expire",
      "explain",
      "expose",
      "express",
      "extend",
      "extra",
      "eye",
      "eyebrow",
      "fabric",
      "face",
      "faculty",
      "fade",
      "faint",
      "faith",
      "fall",
      "false",
      "fame",
      "family",
      "famous",
      "fan",
      "fancy",
      "fantasy",
      "farm",
      "fashion",
      "fat",
      "fatal",
      "father",
      "fatigue",
      "fault",
      "favorite",
      "feature",
      "february",
      "federal",
      "fee",
      "feed",
      "feel",
      "female",
      "fence",
      "festival",
      "fetch",
      "fever",
      "few",
      "fiber",
      "fiction",
      "field",
      "figure",
      "file",
      "film",
      "filter",
      "final",
      "find",
      "fine",
      "finger",
      "finish",
      "fire",
      "firm",
      "first",
      "fiscal",
      "fish",
      "fit",
      "fitness",
      "fix",
      "flag",
      "flame",
      "flash",
      "flat",
      "flavor",
      "flee",
      "flight",
      "flip",
      "float",
      "flock",
      "floor",
      "flower",
      "fluid",
      "flush",
      "fly",
      "foam",
      "focus",
      "fog",
      "foil",
      "fold",
      "follow",
      "food",
      "foot",
      "force",
      "forest",
      "forget",
      "fork",
      "fortune",
      "forum",
      "forward",
      "fossil",
      "foster",
      "found",
      "fox",
      "fragile",
      "frame",
      "frequent",
      "fresh",
      "friend",
      "fringe",
      "frog",
      "front",
      "frost",
      "frown",
      "frozen",
      "fruit",
      "fuel",
      "fun",
      "funny",
      "furnace",
      "fury",
      "future",
      "gadget",
      "gain",
      "galaxy",
      "gallery",
      "game",
      "gap",
      "garage",
      "garbage",
      "garden",
      "garlic",
      "garment",
      "gas",
      "gasp",
      "gate",
      "gather",
      "gauge",
      "gaze",
      "general",
      "genius",
      "genre",
      "gentle",
      "genuine",
      "gesture",
      "ghost",
      "giant",
      "gift",
      "giggle",
      "ginger",
      "giraffe",
      "girl",
      "give",
      "glad",
      "glance",
      "glare",
      "glass",
      "glide",
      "glimpse",
      "globe",
      "gloom",
      "glory",
      "glove",
      "glow",
      "glue",
      "goat",
      "goddess",
      "gold",
      "good",
      "goose",
      "gorilla",
      "gospel",
      "gossip",
      "govern",
      "gown",
      "grab",
      "grace",
      "grain",
      "grant",
      "grape",
      "grass",
      "gravity",
      "great",
      "green",
      "grid",
      "grief",
      "grit",
      "grocery",
      "group",
      "grow",
      "grunt",
      "guard",
      "guess",
      "guide",
      "guilt",
      "guitar",
      "gun",
      "gym",
      "habit",
      "hair",
      "half",
      "hammer",
      "hamster",
      "hand",
      "happy",
      "harbor",
      "hard",
      "harsh",
      "harvest",
      "hat",
      "have",
      "hawk",
      "hazard",
      "head",
      "health",
      "heart",
      "heavy",
      "hedgehog",
      "height",
      "hello",
      "helmet",
      "help",
      "hen",
      "hero",
      "hidden",
      "high",
      "hill",
      "hint",
      "hip",
      "hire",
      "history",
      "hobby",
      "hockey",
      "hold",
      "hole",
      "holiday",
      "hollow",
      "home",
      "honey",
      "hood",
      "hope",
      "horn",
      "horror",
      "horse",
      "hospital",
      "host",
      "hotel",
      "hour",
      "hover",
      "hub",
      "huge",
      "human",
      "humble",
      "humor",
      "hundred",
      "hungry",
      "hunt",
      "hurdle",
      "hurry",
      "hurt",
      "husband",
      "hybrid",
      "ice",
      "icon",
      "idea",
      "identify",
      "idle",
      "ignore",
      "ill",
      "illegal",
      "illness",
      "image",
      "imitate",
      "immense",
      "immune",
      "impact",
      "impose",
      "improve",
      "impulse",
      "inch",
      "include",
      "income",
      "increase",
      "index",
      "indicate",
      "indoor",
      "industry",
      "infant",
      "inflict",
      "inform",
      "inhale",
      "inherit",
      "initial",
      "inject",
      "injury",
      "inmate",
      "inner",
      "innocent",
      "input",
      "inquiry",
      "insane",
      "insect",
      "inside",
      "inspire",
      "install",
      "intact",
      "interest",
      "into",
      "invest",
      "invite",
      "involve",
      "iron",
      "island",
      "isolate",
      "issue",
      "item",
      "ivory",
      "jacket",
      "jaguar",
      "jar",
      "jazz",
      "jealous",
      "jeans",
      "jelly",
      "jewel",
      "job",
      "join",
      "joke",
      "journey",
      "joy",
      "judge",
      "juice",
      "jump",
      "jungle",
      "junior",
      "junk",
      "just",
      "kangaroo",
      "keen",
      "keep",
      "ketchup",
      "key",
      "kick",
      "kid",
      "kidney",
      "kind",
      "kingdom",
      "kiss",
      "kit",
      "kitchen",
      "kite",
      "kitten",
      "kiwi",
      "knee",
      "knife",
      "knock",
      "know",
      "lab",
      "label",
      "labor",
      "ladder",
      "lady",
      "lake",
      "lamp",
      "language",
      "laptop",
      "large",
      "later",
      "latin",
      "laugh",
      "laundry",
      "lava",
      "law",
      "lawn",
      "lawsuit",
      "layer",
      "lazy",
      "leader",
      "leaf",
      "learn",
      "leave",
      "lecture",
      "left",
      "leg",
      "legal",
      "legend",
      "leisure",
      "lemon",
      "lend",
      "length",
      "lens",
      "leopard",
      "lesson",
      "letter",
      "level",
      "liar",
      "liberty",
      "library",
      "license",
      "life",
      "lift",
      "light",
      "like",
      "limb",
      "limit",
      "link",
      "lion",
      "liquid",
      "list",
      "little",
      "live",
      "lizard",
      "load",
      "loan",
      "lobster",
      "local",
      "lock",
      "logic",
      "lonely",
      "long",
      "loop",
      "lottery",
      "loud",
      "lounge",
      "love",
      "loyal",
      "lucky",
      "luggage",
      "lumber",
      "lunar",
      "lunch",
      "luxury",
      "lyrics",
      "machine",
      "mad",
      "magic",
      "magnet",
      "maid",
      "mail",
      "main",
      "major",
      "make",
      "mammal",
      "man",
      "manage",
      "mandate",
      "mango",
      "mansion",
      "manual",
      "maple",
      "marble",
      "march",
      "margin",
      "marine",
      "market",
      "marriage",
      "mask",
      "mass",
      "master",
      "match",
      "material",
      "math",
      "matrix",
      "matter",
      "maximum",
      "maze",
      "meadow",
      "mean",
      "measure",
      "meat",
      "mechanic",
      "medal",
      "media",
      "melody",
      "melt",
      "member",
      "memory",
      "mention",
      "menu",
      "mercy",
      "merge",
      "merit",
      "merry",
      "mesh",
      "message",
      "metal",
      "method",
      "middle",
      "midnight",
      "milk",
      "million",
      "mimic",
      "mind",
      "minimum",
      "minor",
      "minute",
      "miracle",
      "mirror",
      "misery",
      "miss",
      "mistake",
      "mix",
      "mixed",
      "mixture",
      "mobile",
      "model",
      "modify",
      "mom",
      "moment",
      "monitor",
      "monkey",
      "monster",
      "month",
      "moon",
      "moral",
      "more",
      "morning",
      "mosquito",
      "mother",
      "motion",
      "motor",
      "mountain",
      "mouse",
      "move",
      "movie",
      "much",
      "muffin",
      "mule",
      "multiply",
      "muscle",
      "museum",
      "mushroom",
      "music",
      "must",
      "mutual",
      "myself",
      "mystery",
      "myth",
      "naive",
      "name",
      "napkin",
      "narrow",
      "nasty",
      "nation",
      "nature",
      "near",
      "neck",
      "need",
      "negative",
      "neglect",
      "neither",
      "nephew",
      "nerve",
      "nest",
      "net",
      "network",
      "neutral",
      "never",
      "news",
      "next",
      "nice",
      "night",
      "noble",
      "noise",
      "nominee",
      "noodle",
      "normal",
      "north",
      "nose",
      "notable",
      "note",
      "nothing",
      "notice",
      "novel",
      "now",
      "nuclear",
      "number",
      "nurse",
      "nut",
      "oak",
      "obey",
      "object",
      "oblige",
      "obscure",
      "observe",
      "obtain",
      "obvious",
      "occur",
      "ocean",
      "october",
      "odor",
      "off",
      "offer",
      "office",
      "often",
      "oil",
      "okay",
      "old",
      "olive",
      "olympic",
      "omit",
      "once",
      "one",
      "onion",
      "online",
      "only",
      "open",
      "opera",
      "opinion",
      "oppose",
      "option",
      "orange",
      "orbit",
      "orchard",
      "order",
      "ordinary",
      "organ",
      "orient",
      "original",
      "orphan",
      "ostrich",
      "other",
      "outdoor",
      "outer",
      "output",
      "outside",
      "oval",
      "oven",
      "over",
      "own",
      "owner",
      "oxygen",
      "oyster",
      "ozone",
      "pact",
      "paddle",
      "page",
      "pair",
      "palace",
      "palm",
      "panda",
      "panel",
      "panic",
      "panther",
      "paper",
      "parade",
      "parent",
      "park",
      "parrot",
      "party",
      "pass",
      "patch",
      "path",
      "patient",
      "patrol",
      "pattern",
      "pause",
      "pave",
      "payment",
      "peace",
      "peanut",
      "pear",
      "peasant",
      "pelican",
      "pen",
      "penalty",
      "pencil",
      "people",
      "pepper",
      "perfect",
      "permit",
      "person",
      "pet",
      "phone",
      "photo",
      "phrase",
      "physical",
      "piano",
      "picnic",
      "picture",
      "piece",
      "pig",
      "pigeon",
      "pill",
      "pilot",
      "pink",
      "pioneer",
      "pipe",
      "pistol",
      "pitch",
      "pizza",
      "place",
      "planet",
      "plastic",
      "plate",
      "play",
      "please",
      "pledge",
      "pluck",
      "plug",
      "plunge",
      "poem",
      "poet",
      "point",
      "polar",
      "pole",
      "police",
      "pond",
      "pony",
      "pool",
      "popular",
      "portion",
      "position",
      "possible",
      "post",
      "potato",
      "pottery",
      "poverty",
      "powder",
      "power",
      "practice",
      "praise",
      "predict",
      "prefer",
      "prepare",
      "present",
      "pretty",
      "prevent",
      "price",
      "pride",
      "primary",
      "print",
      "priority",
      "prison",
      "private",
      "prize",
      "problem",
      "process",
      "produce",
      "profit",
      "program",
      "project",
      "promote",
      "proof",
      "property",
      "prosper",
      "protect",
      "proud",
      "provide",
      "public",
      "pudding",
      "pull",
      "pulp",
      "pulse",
      "pumpkin",
      "punch",
      "pupil",
      "puppy",
      "purchase",
      "purity",
      "purpose",
      "purse",
      "push",
      "put",
      "puzzle",
      "pyramid",
      "quality",
      "quantum",
      "quarter",
      "question",
      "quick",
      "quit",
      "quiz",
      "quote",
      "rabbit",
      "raccoon",
      "race",
      "rack",
      "radar",
      "radio",
      "rail",
      "rain",
      "raise",
      "rally",
      "ramp",
      "ranch",
      "random",
      "range",
      "rapid",
      "rare",
      "rate",
      "rather",
      "raven",
      "raw",
      "razor",
      "ready",
      "real",
      "reason",
      "rebel",
      "rebuild",
      "recall",
      "receive",
      "recipe",
      "record",
      "recycle",
      "reduce",
      "reflect",
      "reform",
      "refuse",
      "region",
      "regret",
      "regular",
      "reject",
      "relax",
      "release",
      "relief",
      "rely",
      "remain",
      "remember",
      "remind",
      "remove",
      "render",
      "renew",
      "rent",
      "reopen",
      "repair",
      "repeat",
      "replace",
      "report",
      "require",
      "rescue",
      "resemble",
      "resist",
      "resource",
      "response",
      "result",
      "retire",
      "retreat",
      "return",
      "reunion",
      "reveal",
      "review",
      "reward",
      "rhythm",
      "rib",
      "ribbon",
      "rice",
      "rich",
      "ride",
      "ridge",
      "rifle",
      "right",
      "rigid",
      "ring",
      "riot",
      "ripple",
      "risk",
      "ritual",
      "rival",
      "river",
      "road",
      "roast",
      "robot",
      "robust",
      "rocket",
      "romance",
      "roof",
      "rookie",
      "room",
      "rose",
      "rotate",
      "rough",
      "round",
      "route",
      "royal",
      "rubber",
      "rude",
      "rug",
      "rule",
      "run",
      "runway",
      "rural",
      "sad",
      "saddle",
      "sadness",
      "safe",
      "sail",
      "salad",
      "salmon",
      "salon",
      "salt",
      "salute",
      "same",
      "sample",
      "sand",
      "satisfy",
      "satoshi",
      "sauce",
      "sausage",
      "save",
      "say",
      "scale",
      "scan",
      "scare",
      "scatter",
      "scene",
      "scheme",
      "school",
      "science",
      "scissors",
      "scorpion",
      "scout",
      "scrap",
      "screen",
      "script",
      "scrub",
      "sea",
      "search",
      "season",
      "seat",
      "second",
      "secret",
      "section",
      "security",
      "seed",
      "seek",
      "segment",
      "select",
      "sell",
      "seminar",
      "senior",
      "sense",
      "sentence",
      "series",
      "service",
      "session",
      "settle",
      "setup",
      "seven",
      "shadow",
      "shaft",
      "shallow",
      "share",
      "shed",
      "shell",
      "sheriff",
      "shield",
      "shift",
      "shine",
      "ship",
      "shiver",
      "shock",
      "shoe",
      "shoot",
      "shop",
      "short",
      "shoulder",
      "shove",
      "shrimp",
      "shrug",
      "shuffle",
      "shy",
      "sibling",
      "sick",
      "side",
      "siege",
      "sight",
      "sign",
      "silent",
      "silk",
      "silly",
      "silver",
      "similar",
      "simple",
      "since",
      "sing",
      "siren",
      "sister",
      "situate",
      "six",
      "size",
      "skate",
      "sketch",
      "ski",
      "skill",
      "skin",
      "skirt",
      "skull",
      "slab",
      "slam",
      "sleep",
      "slender",
      "slice",
      "slide",
      "slight",
      "slim",
      "slogan",
      "slot",
      "slow",
      "slush",
      "small",
      "smart",
      "smile",
      "smoke",
      "smooth",
      "snack",
      "snake",
      "snap",
      "sniff",
      "snow",
      "soap",
      "soccer",
      "social",
      "sock",
      "soda",
      "soft",
      "solar",
      "soldier",
      "solid",
      "solution",
      "solve",
      "someone",
      "song",
      "soon",
      "sorry",
      "sort",
      "soul",
      "sound",
      "soup",
      "source",
      "south",
      "space",
      "spare",
      "spatial",
      "spawn",
      "speak",
      "special",
      "speed",
      "spell",
      "spend",
      "sphere",
      "spice",
      "spider",
      "spike",
      "spin",
      "spirit",
      "split",
      "spoil",
      "sponsor",
      "spoon",
      "sport",
      "spot",
      "spray",
      "spread",
      "spring",
      "spy",
      "square",
      "squeeze",
      "squirrel",
      "stable",
      "stadium",
      "staff",
      "stage",
      "stairs",
      "stamp",
      "stand",
      "start",
      "state",
      "stay",
      "steak",
      "steel",
      "stem",
      "step",
      "stereo",
      "stick",
      "still",
      "sting",
      "stock",
      "stomach",
      "stone",
      "stool",
      "story",
      "stove",
      "strategy",
      "street",
      "strike",
      "strong",
      "struggle",
      "student",
      "stuff",
      "stumble",
      "style",
      "subject",
      "submit",
      "subway",
      "success",
      "such",
      "sudden",
      "suffer",
      "sugar",
      "suggest",
      "suit",
      "summer",
      "sun",
      "sunny",
      "sunset",
      "super",
      "supply",
      "supreme",
      "sure",
      "surface",
      "surge",
      "surprise",
      "surround",
      "survey",
      "suspect",
      "sustain",
      "swallow",
      "swamp",
      "swap",
      "swarm",
      "swear",
      "sweet",
      "swift",
      "swim",
      "swing",
      "switch",
      "sword",
      "symbol",
      "symptom",
      "syrup",
      "system",
      "table",
      "tackle",
      "tag",
      "tail",
      "talent",
      "talk",
      "tank",
      "tape",
      "target",
      "task",
      "taste",
      "tattoo",
      "taxi",
      "teach",
      "team",
      "tell",
      "ten",
      "tenant",
      "tennis",
      "tent",
      "term",
      "test",
      "text",
      "thank",
      "that",
      "theme",
      "then",
      "theory",
      "there",
      "they",
      "thing",
      "this",
      "thought",
      "three",
      "thrive",
      "throw",
      "thumb",
      "thunder",
      "ticket",
      "tide",
      "tiger",
      "tilt",
      "timber",
      "time",
      "tiny",
      "tip",
      "tired",
      "tissue",
      "title",
      "toast",
      "tobacco",
      "today",
      "toddler",
      "toe",
      "together",
      "toilet",
      "token",
      "tomato",
      "tomorrow",
      "tone",
      "tongue",
      "tonight",
      "tool",
      "tooth",
      "top",
      "topic",
      "topple",
      "torch",
      "tornado",
      "tortoise",
      "toss",
      "total",
      "tourist",
      "toward",
      "tower",
      "town",
      "toy",
      "track",
      "trade",
      "traffic",
      "tragic",
      "train",
      "transfer",
      "trap",
      "trash",
      "travel",
      "tray",
      "treat",
      "tree",
      "trend",
      "trial",
      "tribe",
      "trick",
      "trigger",
      "trim",
      "trip",
      "trophy",
      "trouble",
      "truck",
      "true",
      "truly",
      "trumpet",
      "trust",
      "truth",
      "try",
      "tube",
      "tuition",
      "tumble",
      "tuna",
      "tunnel",
      "turkey",
      "turn",
      "turtle",
      "twelve",
      "twenty",
      "twice",
      "twin",
      "twist",
      "two",
      "type",
      "typical",
      "ugly",
      "umbrella",
      "unable",
      "unaware",
      "uncle",
      "uncover",
      "under",
      "undo",
      "unfair",
      "unfold",
      "unhappy",
      "uniform",
      "unique",
      "unit",
      "universe",
      "unknown",
      "unlock",
      "until",
      "unusual",
      "unveil",
      "update",
      "upgrade",
      "uphold",
      "upon",
      "upper",
      "upset",
      "urban",
      "urge",
      "usage",
      "use",
      "used",
      "useful",
      "useless",
      "usual",
      "utility",
      "vacant",
      "vacuum",
      "vague",
      "valid",
      "valley",
      "valve",
      "van",
      "vanish",
      "vapor",
      "various",
      "vast",
      "vault",
      "vehicle",
      "velvet",
      "vendor",
      "venture",
      "venue",
      "verb",
      "verify",
      "version",
      "very",
      "vessel",
      "veteran",
      "viable",
      "vibrant",
      "vicious",
      "victory",
      "video",
      "view",
      "village",
      "vintage",
      "violin",
      "virtual",
      "virus",
      "visa",
      "visit",
      "visual",
      "vital",
      "vivid",
      "vocal",
      "voice",
      "void",
      "volcano",
      "volume",
      "vote",
      "voyage",
      "wage",
      "wagon",
      "wait",
      "walk",
      "wall",
      "walnut",
      "want",
      "warfare",
      "warm",
      "warrior",
      "wash",
      "wasp",
      "waste",
      "water",
      "wave",
      "way",
      "wealth",
      "weapon",
      "wear",
      "weasel",
      "weather",
      "web",
      "wedding",
      "weekend",
      "weird",
      "welcome",
      "west",
      "wet",
      "whale",
      "what",
      "wheat",
      "wheel",
      "when",
      "where",
      "whip",
      "whisper",
      "wide",
      "width",
      "wife",
      "wild",
      "will",
      "win",
      "window",
      "wine",
      "wing",
      "wink",
      "winner",
      "winter",
      "wire",
      "wisdom",
      "wise",
      "wish",
      "witness",
      "wolf",
      "woman",
      "wonder",
      "wood",
      "wool",
      "word",
      "work",
      "world",
      "worry",
      "worth",
      "wrap",
      "wreck",
      "wrestle",
      "wrist",
      "write",
      "wrong",
      "yard",
      "year",
      "yellow",
      "you",
      "young",
      "youth",
      "zebra",
      "zero",
      "zone",
      "zoo"
    ];

  }

  // Drops the unlocked session (call when tearing down this manager instance).
  dispose() {
    this.closeSession();
  }

  // Generate QNet address from mnemonic (extension-compatible)
  async generateQNetAddressFromMnemonic(mnemonic, accountIndex = 0) {
    try {
      // The recovery phrase's 64-byte seed
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      
      // The QNet address of the ML-DSA-65 key the seed derives
      const result = await this.generateQNetAddress(seed, accountIndex);
      
      // Return just the address for backward compatibility
      return result.address;
    } catch (error) {
      // console.error('Error generating QNet address:', error);
      throw error;
    }
  }

  // Generate QNet address from Solana address (for simple display)
  generateQNetAddressFromSolana(solanaAddress) {
    try {
      // Generate deterministic QNet address from Solana address
      const fullHash = Buffer.from(sha512(Buffer.from(solanaAddress + 'qnet-eon-bridge', 'utf8'))).toString('hex');
      
      // Format: 19 chars + "eon" + 15 chars + 8 char SHA3-256 checksum = 45 total
      const part1 = fullHash.substring(0, 19).toLowerCase();
      const part2 = fullHash.substring(19, 34).toLowerCase();

      // Generate SHA3-256 checksum (MUST match server! 4 bytes = 8 hex chars)
      const { sha3_256 } = require('js-sha3');
      const addressWithoutChecksum = part1 + 'eon' + part2;
      const checksumHex = sha3_256(addressWithoutChecksum);
      const checksum = checksumHex.substring(0, 8).toLowerCase();

      return `${part1}eon${part2}${checksum}`;
    } catch (error) {
      // console.error('Error generating QNet address from Solana:', error);
      return null;
    }
  }
  
  // Re-derive the QNet address to the canonical pure-Dilithium identity. A derivation that fails throws:
  // an address the seed does not make (the old Solana-bridge fallback) would never match the node.
  async migrateQNetAddress(wallet) {
    // Already on the current FIPS-204 identity — nothing to do. (A wallet from the old
    // round-3 build carries the previous 'QNET_WALLET_MLDSA65_v1' marker, so it does NOT
    // match here and falls through to be re-derived below.)
    if (wallet.qnetKeypair && wallet.qnetKeypair.path === 'QNET_WALLET_MLDSA65_fips204') {
      return wallet;
    }

    // Any wallet holding a mnemonic (including one with a stale Ed25519 key) re-derives
    // to the pure-Dilithium address so app and node agree on one identity per seed.
    if (wallet.mnemonic) {
      const seed = bip39.mnemonicToSeedSync(wallet.mnemonic);
      const result = await this.generateQNetAddress(seed, 0);
      wallet.qnetAddress = result.address;
      wallet.qnetKeypair = {
        publicKey: Array.from(result.keypair.publicKey),
        privateKey: Array.from(result.keypair.privateKey),
        path: result.keypair.path
      };
      result.keypair.privateKey.fill(0);
      return wallet;
    }

    // No mnemonic (a wallet from the earliest builds): keep the address it has, or show the bridge address.
    if (!wallet.qnetAddress) {
      wallet.qnetAddress = this.generateQNetAddressFromSolana(wallet.solanaAddress || wallet.address);
    }
    return wallet;
  }

  // Generate QNet EON address — PURE DILITHIUM (ML-DSA-65, F0.1). The QNet identity is the
  // post-quantum key derived from the mnemonic; the address commits to it. Byte-identical to the
  // node (genesis_key.rs): the native module SHAKE-256s the canonical seed string into the 32-byte
  // ML-DSA-65 KeyGen seed, then EON = SHA512(pk) formatted. Ed25519/Solana keys are derived
  // separately (m/44'/501') and are UNTOUCHED — Ed25519 is a Solana-only credential.
  async generateQNetAddress(seed, accountIndex = 0) {
    try {
      // Canonical wallet seed string — MUST byte-match the node's WALLET_SEED_PREFIX + hex(bip39_seed64).
      const seedString = walletSeedString(seed);

      // Native ML-DSA-65 keygen: shake256(seedString) -> 32-byte xi -> keypair (hex pk 1952B / sk 4032B).
      const { generateRawDilithiumKeypair, derivePublicKeyFromSeed } = require('../crypto/DilithiumCrypto');
      const kp = await generateRawDilithiumKeypair(seedString);
      if (!/^[0-9a-f]{3904}$/i.test(kp.publicKey || '') || !/^[0-9a-f]{8064}$/i.test(kp.secretKey || '')) {
        throw new Error('ML-DSA-65 keygen returned a malformed key');
      }
      const pkBytes = Uint8Array.from(kp.publicKey.match(/.{1,2}/g).map(h => parseInt(h, 16)));
      const skBytes = Uint8Array.from(kp.secretKey.match(/.{1,2}/g).map(h => parseInt(h, 16)));

      const address = eonFromPublicKeyBytes(pkBytes);
      // A second keygen from the same seed must give the same identity: a key that came from anything but
      // this seed (a racing self-test, a fault) is refused before it can receive funds. Only the public key of
      // the second keygen comes back (MPLAT-R2-05).
      const againPk = await derivePublicKeyFromSeed(seedString);
      if (typeof againPk !== 'string' || !/^[0-9a-f]{3904}$/i.test(againPk) || againPk.toLowerCase() !== kp.publicKey.toLowerCase()
          || eonFromPublicKeyBytes(Uint8Array.from(againPk.match(/.{1,2}/g).map(h => parseInt(h, 16)))) !== address) {
        skBytes.fill(0);
        throw new Error('ML-DSA-65 keygen is not deterministic on this device');
      }

      // keypair keeps a byte-array shape (publicKey/privateKey Uint8Array) so existing storage sites
      // (Array.from(...)) keep working; the bytes are now the ML-DSA-65 wallet key, not Ed25519.
      return {
        address,
        // path marker bumped to '_fips204' so a wallet created by the OLD round-3 native
        // build (same seed prefix, same '_v1' marker, but a different key) is NOT mistaken
        // for already-migrated — migrateQNetAddress re-derives it to this FIPS-204 identity.
        keypair: { publicKey: pkBytes, privateKey: skBytes, path: 'QNET_WALLET_MLDSA65_fips204' },
      };
    } catch (error) {
      throw new Error('Failed to generate QNet address (pure Dilithium): ' + ((error && error.message) || error));
    }
  }

  // The Solana key by hardened key derivation (ed25519-hd-key) on the common Solana account path m/44'/501'/accountIndex'/0'.
  // A failure throws. Raw seed bytes are never a key: that address would exist nowhere else.
  async deriveHDKeypair(seed, accountIndex = 0) {
    const path = `m/44'/501'/${accountIndex}'/0'`;
    const seedHex = Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join('');
    const { key } = derivePath(path, seedHex);
    if (!key || key.length !== 32) throw new Error('Solana key derivation failed');
    return key;
  }

  // Async wrapper for mnemonic to seed conversion
  async mnemonicToSeedAsync(mnemonic) {
    return new Promise((resolve) => {
      // Use setTimeout to avoid blocking the main thread
      setTimeout(() => {
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        resolve(seed);
      }, 0);
    });
  }

  // A secp256k1 address from the SAME recovery-phrase seed on path m/44'/60'/0'/0/0, pinned by a known-answer vector
  // (mnemonic "abandon…about" → 0x9858EfFD232B4033E47d90003D41EC34EcaEda94). Additive and independent: the QNet
  // (ML-DSA-65) and Solana (Ed25519) derivations are UNTOUCHED.
  async deriveSecp256k1Account(seed) {
    // The secp256k1 address is an ADDITIVE sub-feature. @noble/curves is now a direct dependency, but if it is ever
    // unresolvable (nested/strict install layout, or a future @scure/bip32 that vendors curves),
    // degrade gracefully (return null) instead of throwing out of core wallet creation. QNet +
    // Solana identity must still be created even if the secp256k1 address cannot be derived.
    try {
      const { HDKey } = require('@scure/bip32');
      const { secp256k1 } = require('@noble/curves/secp256k1');
      const { keccak256 } = require('js-sha3');
      const seedBytes = seed instanceof Uint8Array ? seed : new Uint8Array(seed);
      const hd = HDKey.fromMasterSeed(seedBytes).derive("m/44'/60'/0'/0/0");
      const priv = hd.privateKey;
      const pub = secp256k1.getPublicKey(priv, false); // 65B uncompressed 0x04||X||Y
      const addrHex = keccak256(pub.slice(1)).slice(-40); // keccak256(pubkey[1:])[-20 bytes]
      const hashHex = keccak256(addrHex); // mixed-case checksum over the lowercase hex
      let address = '0x';
      for (let i = 0; i < 40; i++) address += (parseInt(hashHex[i], 16) >= 8 ? addrHex[i].toUpperCase() : addrHex[i]);
      return { address, privateKey: Buffer.from(priv).toString('hex'), publicKey: Buffer.from(pub).toString('hex'), path: "m/44'/60'/0'/0/0" };
    } catch (error) {
      // console.warn('secp256k1 derivation unavailable, omitting the field:', error);
      return null;
    }
  }

  async generateWallet() {
    try {
      // A 12-word recovery phrase with its checksum (bip39 library)
      const mnemonic = bip39.generateMnemonic();
      
      // Use ASYNC seed generation to avoid blocking UI
      const seed = await this.mnemonicToSeedAsync(mnemonic);
      
      // The Solana key on the common Solana account path m/44'/501'/0'/0'
      const keypairSeed = await this.deriveHDKeypair(seed, 0);
      
      // Create keypair from derived seed  
      const keypair = Keypair.fromSeed(keypairSeed);
      
      // The QNet address and its ML-DSA-65 key from the same seed
      const qnetResult = await this.generateQNetAddress(seed, 0);

      // The secp256k1 address from the SAME seed (m/44'/60').
      const secpResult = await this.deriveSecp256k1Account(seed);

      // Store mnemonic temporarily for wallet creation flow
      const wallet = {
        publicKey: keypair.publicKey.toString(),
        secretKey: Array.from(keypair.secretKey),
        mnemonic: mnemonic, // Needed for creation flow, will be encrypted when stored
        address: keypair.publicKey.toString(),
        solanaAddress: keypair.publicKey.toString(),
        qnetAddress: qnetResult.address,
        qnetKeypair: {
          publicKey: Array.from(qnetResult.keypair.publicKey),
          privateKey: Array.from(qnetResult.keypair.privateKey),
          path: qnetResult.keypair.path
        },
        // The secp256k1 address is additive: if deriveSecp256k1Account returned null (curves unresolvable), omit it —
        // core QNet + Solana wallet creation still succeeds.
        secp256k1Address: secpResult ? secpResult.address : null,
        evmKeypair: secpResult ? { publicKey: secpResult.publicKey, privateKey: secpResult.privateKey, path: secpResult.path } : null
      };

      // Temporarily attach mnemonic for storage only
      wallet._tempMnemonic = mnemonic;
      return wallet;
    } catch (error) {
      // console.error('Error generating wallet:', error);
      throw error;
    }
  }

  // A 12-word recovery phrase with its checksum
  async generateMnemonic() {
    const words = this.BIP39_WORDLIST;
    
    try {
      // Entropy, then the first bits of its SHA-256 as the checksum
      const entropy = new Uint8Array(16); // 128 bits for 12 words
      
      // Use native crypto-secure random values (from react-native-get-random-values)
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(entropy);
      } else {
        // This should never happen with react-native-get-random-values imported
        throw new Error('Secure random number generator not available - critical security issue');
      }
      
      // SHA-256 of the entropy: its first bits are the checksum
      const hashBytes = sha256(entropy);

      // Calculate checksum bits (entropy bits / 32 = 128 / 32 = 4 bits)
      const checksumBits = 4;
      const checksumByte = hashBytes[0];
      
      // Combine entropy and checksum into bit array
      const bits = [];
      
      // Add all entropy bits
      for (let i = 0; i < entropy.length; i++) {
        for (let j = 7; j >= 0; j--) {
          bits.push((entropy[i] >> j) & 1);
        }
      }
      
      // Add checksum bits (first 4 bits from hash)
      for (let i = 0; i < checksumBits; i++) {
        bits.push((checksumByte >> (7 - i)) & 1);
      }
      
      // Convert bits to words (11 bits per word)
      const mnemonic = [];
      for (let i = 0; i < 12; i++) {
        let index = 0;
        for (let j = 0; j < 11; j++) {
          index = (index << 1) | bits[i * 11 + j];
        }
        mnemonic.push(words[index]);
      }
      
      return mnemonic.join(' ');
    } catch (error) {
      // console.error('Error generating the recovery phrase:', error);
      throw new Error('Failed to generate secure mnemonic');
    }
  }

  // Validates a 12- to 24-word recovery phrase and its checksum
  validateBIP39Mnemonic(mnemonic) {
    try {
      const mnemonicWords = mnemonic.trim().toLowerCase().split(/\s+/);
      
      // Check word count
      if (![12, 15, 18, 21, 24].includes(mnemonicWords.length)) {
        return { valid: false, error: 'Invalid word count. Must be 12, 15, 18, 21, or 24 words.' };
      }

      // Check if all words are in wordlist and get indices
      const indices = [];
      for (const word of mnemonicWords) {
        const index = this.getBIP39WordList().indexOf(word);
        if (index === -1) {
          return { valid: false, error: `Word "${word}" is not in the recovery-phrase word list.` };
        }
        indices.push(index);
      }

      // Convert indices to bits
      const bits = [];
      for (const index of indices) {
        for (let i = 10; i >= 0; i--) {
          bits.push((index >> i) & 1);
        }
      }

      // Split entropy and checksum
      const totalBits = mnemonicWords.length * 11;
      const checksumBits = mnemonicWords.length / 3; // CS = ENT / 32, and ENT = totalBits - CS
      const entropyBits = totalBits - checksumBits;
      
      // Extract entropy bytes
      const entropyBytes = [];
      for (let i = 0; i < entropyBits; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) {
          byte = (byte << 1) | bits[i + j];
        }
        entropyBytes.push(byte);
      }

      // Calculate expected checksum
      const entropy = new Uint8Array(entropyBytes);
      const hashBytes = sha256(entropy);

      // Extract actual checksum from mnemonic
      let actualChecksum = 0;
      for (let i = 0; i < checksumBits; i++) {
        actualChecksum = (actualChecksum << 1) | bits[entropyBits + i];
      }

      // Extract expected checksum from hash
      let expectedChecksum = 0;
      for (let i = 0; i < checksumBits; i++) {
        expectedChecksum = (expectedChecksum << 1) | ((hashBytes[0] >> (7 - i)) & 1);
      }

      if (actualChecksum !== expectedChecksum) {
        return { valid: false, error: 'Invalid checksum. The seed phrase is corrupted or incorrect.' };
      }

      return { valid: true, entropy: entropy };
    } catch (error) {
      // console.error('Error validating the recovery phrase:', error);
      return { valid: false, error: 'Failed to validate mnemonic.' };
    }
  }

  // The recovery-phrase word list (helper function)
  getBIP39WordList() {
    // The full 2048-word list
    return this.BIP39_WORDLIST;
  }

  /**
   * A recovery phrase as its seed derivation reads it: NFKD, lower case, single spaces, nothing around it — the extension's
   * canonicalizeMnemonic, byte for byte (R3-XPD-07). A phrase typed with capitals, on two lines or with double
   * spaces is the same words, so it imports as the same wallet the extension derives from it, instead of being refused.
   */
  static canonicalMnemonic(input) {
    return String(input == null ? '' : input).normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ');
  }

  // Import a wallet from a 12- or 24-word recovery phrase, validated
  async importWallet(mnemonic) {
    try {
      // Validated with the bip39 library, on the canonical spelling (R3-XPD-07).
      const trimmedMnemonic = WalletManager.canonicalMnemonic(mnemonic);
      if (!bip39.validateMnemonic(trimmedMnemonic)) {
        throw Object.assign(new Error('Invalid mnemonic phrase'), { code: 'INVALID_PHRASE' });
      }

      // Use ASYNC seed generation to avoid blocking UI
      const seed = await this.mnemonicToSeedAsync(trimmedMnemonic);
      
      // The Solana key on the common Solana account path m/44'/501'/0'/0'
      const keypairSeed = await this.deriveHDKeypair(seed, 0);
      
      // Create keypair from derived seed
      const keypair = Keypair.fromSeed(keypairSeed);
      
      // The QNet address and its ML-DSA-65 key from the same seed
      const qnetResult = await this.generateQNetAddress(seed, 0);

      // The secp256k1 address from the SAME seed (m/44'/60').
      const secpResult = await this.deriveSecp256k1Account(seed);

      // Store mnemonic temporarily for import flow
      const wallet = {
        publicKey: keypair.publicKey.toString(),
        secretKey: Array.from(keypair.secretKey),
        mnemonic: trimmedMnemonic, // Needed for import flow, will be encrypted when stored
        address: keypair.publicKey.toString(),
        solanaAddress: keypair.publicKey.toString(),
        qnetAddress: qnetResult.address,
        qnetKeypair: {
          publicKey: Array.from(qnetResult.keypair.publicKey),
          privateKey: Array.from(qnetResult.keypair.privateKey),
          path: qnetResult.keypair.path
        },
        // The secp256k1 address is additive: if deriveSecp256k1Account returned null (curves unresolvable), omit it —
        // core QNet + Solana wallet import still succeeds.
        secp256k1Address: secpResult ? secpResult.address : null,
        evmKeypair: secpResult ? { publicKey: secpResult.publicKey, privateKey: secpResult.privateKey, path: secpResult.path } : null,
        imported: true
      };
      
      // Also keep temp reference for storage
      wallet._tempMnemonic = trimmedMnemonic;
      return wallet;
    } catch (error) {
      // console.error('Error importing wallet:', error);
      throw Object.assign(new Error(error.message || 'Failed to import wallet. Please check your seed phrase and try again.'),
        error && error.code ? { code: error.code } : {});
    }
  }

  // ── Vault, session, unlock ──────────────────────────────────────────────────────────────────────
  //
  // The vault is envelope-encrypted (src/crypto/Vault.js). Unlocking opens a session: the data key stays
  // here as a non-extractable CryptoKey behind an opaque token, and the screen keeps the token, never the
  // password. Every password check (unlock, reveal, change, biometric enrolment, delete) goes through one
  // lockout kept in the Keychain on the boot clock.

  static KEYCHAIN_SERVICE = 'com.qnet.wallet.biometric';
  // The vault secret of a wallet that opens with the screen lock (services/DeviceAuthStore). On iOS it is an item in
  // the app's own Keychain group (MVA-R2-05); an older build's item under KEYCHAIN_SERVICE (in the group named after
  // com.qnet.mobile) is read as a fallback and moved here at the next unlock: written under this name first, deleted
  // there only then, so the secret is never absent.
  static DEVICE_AUTH_SERVICE = 'com.qnetmobile.vault-secret';
  // The staging item of a vault-secret rotation or of a move from a password, holding the current and the next
  // secret (MVA-R3-03).
  static DEVICE_AUTH_NEXT_SERVICE = 'com.qnetmobile.vault-secret.next';
  // Read in this order: a rotation that did not finish first (its item holds both secrets), then the current item,
  // then an older build's.
  static DEVICE_AUTH_SERVICES = [
    WalletManager.DEVICE_AUTH_NEXT_SERVICE, WalletManager.DEVICE_AUTH_SERVICE, WalletManager.KEYCHAIN_SERVICE,
  ];
  static VAULT_KEY = 'qnet_wallet';
  static VAULT_BACKUP_KEY = 'qnet_wallet.bak';
  static MIN_PASSWORD_LENGTH = PASSWORD_MIN_LENGTH;
  static INSTALL_MARKER = 'qnet_install_marker';
  // What Delete wallet leaves on the device: the display language.
  static ERASE_ALLOW_LIST = ['qnet_language'];

  /**
   * One rule on every device: a wallet opens with the device's screen lock (Face ID, Touch ID, a fingerprint or the
   * device passcode) when the device has one that can hold a secret, and with a wallet password otherwise. Under the
   * screen lock the vault is still sealed with a secret — a generated one DeviceAuthStore keeps behind that lock — so
   * the storage format and every signing path stay those of a typed password. This flag says which of the two the
   * stored wallet uses; it is written before the vault it describes.
   */
  static DEVICE_AUTH_FLAG = 'qnet_device_auth';
  // When this device's screen lock took a secret it then could not give back after the prompt passed (a system prompt
  // path that does not work on this build), in ms: for DEVICE_AUTH_BROKEN_MS it counts as a device without one, and a
  // new wallet gets a password. A failure that may have been the Keystore's for a moment is not held for ever: the mark
  // lapses, and any read-back through the screen lock that works clears it.
  static DEVICE_AUTH_BROKEN_KEY = 'qnet_device_auth_broken';
  static DEVICE_AUTH_BROKEN_MS = 7 * 24 * 3600_000;
  // A wallet under the screen lock whose secret is gone moving to a password (reprotectWithPassword): the password wrap
  // of the vault it started from. A vault stored with another one is the moved one (_settlePasswordMove).
  static PASSWORD_MOVE_KEY = 'qnet_device_auth_to_password';

  /** Whether this device can open a new wallet with its screen lock now. */
  async deviceAuthAvailable() {
    return (await this._deviceAuthAvailability()) === 'yes';
  }

  // 'yes', 'no' (no usable screen lock, or one marked broken) or 'unknown' (the device did not answer this time).
  async _deviceAuthAvailability() {
    try {
      const raw = await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_BROKEN_KEY);
      if (raw !== null) {
        const age = Date.now() - Number(raw);
        if (Number(raw) > 0 && age >= 0 && age < WalletManager.DEVICE_AUTH_BROKEN_MS) return 'no';
        await AsyncStorage.removeItem(WalletManager.DEVICE_AUTH_BROKEN_KEY); // lapsed, or a clock set back past it
      }
    } catch (_) { /* storage that cannot be read decides nothing here */ }
    return deviceAuthStoreAvailability();
  }

  /** Whether the stored wallet opens with the device's screen lock (no wallet password); false when that cannot be read. */
  async usesDeviceAuth() {
    try {
      return await this._readDeviceAuthFlag();
    } catch (_) {
      return false;
    }
  }

  /**
   * 'yes' | 'no' | 'unknown': usesDeviceAuth, with a few quick retries (as vaultState), and storage that still cannot be
   * read is 'unknown', never 'no'. The lock screen is chosen by this: a failed read must not put a screen-lock wallet,
   * which has no password, behind a password field whose attempts the lockout counts.
   */
  async deviceAuthState({ attempts = 3, retryMs = 300 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        return (await this._readDeviceAuthFlag()) ? 'yes' : 'no';
      } catch (_) {
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    return 'unknown';
  }

  // The flag as stored (a move to a password that stopped is settled first); throws when storage cannot be read.
  async _readDeviceAuthFlag() {
    await this._settlePasswordMove();
    if ((await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)) === '1') return true;
    return this._adoptDeviceAuthFlag();
  }

  // A move to a password (reprotectWithPassword) that stopped: the stored vault tells whether its new wrap was written.
  // Written: the wallet opens with the password from now on, so the flag goes. Not written: nothing changed. Copies that
  // cannot be read now tell nothing: the marker stays and this throws (MA-R3-01).
  async _settlePasswordMove() {
    const raw = await AsyncStorage.getItem(WalletManager.PASSWORD_MOVE_KEY);
    if (!raw) return;
    let from = null;
    try { from = JSON.parse(raw).from; } catch (_) { from = null; }
    let stored = [];
    if (typeof from === 'string') {
      try {
        stored = await this._vaultCandidates();
      } catch (e) {
        if (!(e instanceof VaultCorruptError)) throw e;
      }
    }
    const moved = stored.some((c) => isVaultV4(c.vault) && c.vault.pw && c.vault.pw.ct !== from);
    if (moved) await AsyncStorage.removeItem(WalletManager.DEVICE_AUTH_FLAG);
    await AsyncStorage.removeItem(WalletManager.PASSWORD_MOVE_KEY);
  }

  /**
   * A wallet under the screen lock: 'present' while the screen lock still holds its vault secret, 'gone' once it does
   * not (the screen lock was removed, which deletes the secret for good, even when a screen lock is set again). Asks
   * nothing. While the wallet is open, 'gone' is the one moment it can still be protected again (reprotectWith...).
   */
  async deviceAuthSecretState() {
    return deviceAuthStoreState(WalletManager.DEVICE_AUTH_SERVICES);
  }

  // iOS: a wallet an older build sealed under the screen lock may lack the flag; its screen-lock item (which a password
  // wallet never holds, see storeWallet) says so, and the flag follows. Once per launch; the check asks nothing.
  async _adoptDeviceAuthFlag() {
    if (Platform.OS !== 'ios' || this._flagAdoptChecked) return false;
    const stored = await this.vaultState({ attempts: 1 });
    if (stored === 'unreadable') throw new Error('The stored wallet cannot be read now');
    if (stored !== 'ok') {
      this._flagAdoptChecked = true;
      return false;
    }
    for (const service of [WalletManager.DEVICE_AUTH_SERVICE, WalletManager.DEVICE_AUTH_NEXT_SERVICE]) {
      if (await Keychain.hasGenericPassword({ service })) {
        await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_FLAG, '1');
        this._flagAdoptChecked = true;
        return true;
      }
    }
    // Checked only once every read answered (a Keychain that threw is asked again next time).
    this._flagAdoptChecked = true;
    return false;
  }

  static VAULT_ITERATIONS_V3 = 600_000; // legacy vault versions, read only to migrate them
  static VAULT_ITERATIONS_V2 = 100_000;

  /** The wallet as the screen may hold it: addresses and public keys, no private key and no seed phrase. */
  static publicWallet(w) {
    if (!w) return w;
    const out = { ...w };
    delete out.secretKey;
    delete out.mnemonic;
    delete out._tempMnemonic;
    delete out.password;
    if (out.qnetKeypair) out.qnetKeypair = { publicKey: out.qnetKeypair.publicKey, path: out.qnetKeypair.path };
    if (out.evmKeypair) out.evmKeypair = { publicKey: out.evmKeypair.publicKey, path: out.evmKeypair.path };
    return out;
  }

  static isSessionToken(x) {
    return !!x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, SESSION_CRED);
  }

  // A frozen object that only this module can make or recognize; it is compared by identity (sessionOpen), so a copy
  // of it opens nothing.
  _openSession(dekKey, vaultId) {
    const token = Object.freeze({ [SESSION_CRED]: this._bytesToHex(randomBytes(16)) });
    this._session = { token, dekKey, vaultId };
    // A walk waits for these (_certifiedFresh): one that started before they were read would root at the pin.
    this._anchorsReady = this._loadVerifiedAnchors().catch(() => {});
    return token;
  }

  /** Whether `token` is the session open now. */
  sessionOpen(token) {
    return !!this._session && this._session.token === token;
  }

  /** Locks: the data key and its token are dropped; the next use needs the password or biometrics. */
  closeSession() {
    this._session = null;
    if (this._anchorsSaveTimer) { clearTimeout(this._anchorsSaveTimer); this._anchorsSaveTimer = null; }
  }

  // Checkpoints this device verified persist across sessions sealed under the vault's data key (authenticated
  // encryption with its own AAD), so a later walk resumes there instead of at the pin, and nothing written
  // to storage by anyone else can pose as one. Without an open session (a background wake) the pin alone
  // roots the walk.
  static ANCHORS_KEY = 'qnet_qc_anchors';

  // A record of another chain (another set of genesis identities) is dropped, never imported. One written before records
  // named their chain is this build's: the app has only ever known one.
  async _loadVerifiedAnchors() {
    const s = this._session;
    const raw = await AsyncStorage.getItem(WalletManager.ANCHORS_KEY);
    if (!s || !raw) return;
    try {
      const record = JSON.parse(raw);
      if (record.vault !== s.vaultId) return;
      const kept = await openRecord(s.dekKey, record, 'qc-anchors');
      if (kept.chain !== undefined && kept.chain !== chainIdentity()) {
        await AsyncStorage.removeItem(WalletManager.ANCHORS_KEY);
        return;
      }
      importVerifiedAnchors(kept.anchors);
    } catch (_) { /* unreadable or another vault's: the pin roots the walk */ }
  }

  // The anchors kept from an earlier session were found not to be this chain's lineage (QcLightClient onLineageReset):
  // the stored copy goes too, so the next session does not import them again.
  _dropStoredAnchors() {
    this._anchorsSavedAt = 0;
    AsyncStorage.removeItem(WalletManager.ANCHORS_KEY).catch(() => {});
  }

  // At most one write a minute; a call inside that minute schedules one at its end, so the last progress of a
  // long walk is kept too, not only the state at the first call.
  async _saveVerifiedAnchors() {
    const s = this._session;
    if (!s) return;
    const now = Date.now();
    const wait = 60_000 - (now - (this._anchorsSavedAt || 0));
    if (wait > 0) {
      if (!this._anchorsSaveTimer) {
        this._anchorsSaveTimer = setTimeout(() => {
          this._anchorsSaveTimer = null;
          this._saveVerifiedAnchors().catch(() => {});
        }, wait);
        if (this._anchorsSaveTimer && typeof this._anchorsSaveTimer.unref === 'function') this._anchorsSaveTimer.unref();
      }
      return;
    }
    this._anchorsSavedAt = now;
    try {
      const kept = { anchors: exportVerifiedAnchors(), chain: chainIdentity() };
      const record = await sealRecord(s.dekKey, s.vaultId, kept, 'qc-anchors');
      if (this._session !== s) return; // locked or switched meanwhile
      await AsyncStorage.setItem(WalletManager.ANCHORS_KEY, JSON.stringify(record));
    } catch (_) { /* kept next time */ }
  }

  // The last verified balances of the open wallet, sealed under the vault's data key like the anchors, so the Assets tab
  // shows them the moment the wallet opens (marked as being updated) instead of nothing while the first read and its
  // proof run. Written only from a figure a proof certified; tagged with the chain, so another chain's never shows.
  static BALANCE_CACHE_KEY = 'qnet_balance_cache';

  /** Keeps `snapshot` ({ owner, qnc, qncNano, blockHeight, sol, oneDev, tokens, at }) for the open wallet. */
  async saveBalanceSnapshot(snapshot) {
    const s = this._session;
    if (!s || !snapshot || typeof snapshot.owner !== 'string' || !snapshot.owner) return false;
    try {
      const kept = { ...snapshot, chain: chainIdentity() };
      const record = await sealRecord(s.dekKey, s.vaultId, kept, 'balance-cache');
      if (this._session !== s) return false; // locked or switched meanwhile
      await AsyncStorage.setItem(WalletManager.BALANCE_CACHE_KEY, JSON.stringify(record));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** The snapshot kept for `owner` in the open session, or null (none, another wallet's, another chain's, unreadable). */
  async loadBalanceSnapshot(owner) {
    const s = this._session;
    if (!s || !owner) return null;
    try {
      const record = JSON.parse((await AsyncStorage.getItem(WalletManager.BALANCE_CACHE_KEY)) || 'null');
      if (!record || typeof record !== 'object' || record.vault !== s.vaultId) return null;
      const snap = await openRecord(s.dekKey, record, 'balance-cache');
      if (!snap || snap.owner !== owner || snap.chain !== chainIdentity()) return null;
      return snap;
    } catch (_) {
      return null;
    }
  }

  /** A vault secret the user never sees (iOS): 256 random bits, base64. */
  generateVaultPassword() {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  }

  // A stored copy's write generation: every vault write carries one above every copy stored before it (_nextGen), so of
  // two copies that differ the newer one is known. A copy an older build wrote has none: 0.
  static _genOf(vault) {
    const g = vault && vault.gen;
    return Number.isSafeInteger(g) && g >= 0 ? g : 0;
  }

  // The stored copies that parse, the newest generation first (the primary first among equals), the same text once. By
  // default only the newest generation: iOS writes a multiSet key by key, so a write that stopped between the two
  // copies leaves an older one (a password change's copy under the old password), which nothing may read as the
  // wallet; `all` adds the older ones for _openVault, which falls back to one only when no newer copy could be tried.
  // None stored: []. Neither parses: VaultCorruptError — the data is left exactly as it is.
  async _vaultCandidates({ all = false } = {}) {
    const pairs = await AsyncStorage.multiGet([WalletManager.VAULT_KEY, WalletManager.VAULT_BACKUP_KEY]);
    const [primary, backup] = pairs.map(([, v]) => v);
    if (!primary && !backup) return [];
    const out = [];
    for (const [raw, fromBackup] of [[primary, false], [backup, true]]) {
      if (!raw || out.some((c) => c.raw === raw)) continue;
      try {
        const vault = JSON.parse(raw);
        if (vault && typeof vault === 'object') out.push({ raw, vault, fromBackup, gen: WalletManager._genOf(vault) });
      } catch (_) { /* the other copy may still be good */ }
    }
    if (out.length === 0) throw new VaultCorruptError();
    out.sort((a, b) => b.gen - a.gen); // stable: the primary stays first among equals
    return all ? out : out.filter((c) => c.gen === out[0].gen);
  }

  // The generation the next write of `vault` carries: one above `vault`'s own and every stored copy's.
  async _nextGen(vault) {
    const stored = await this._vaultCandidates({ all: true }).catch(() => []);
    return 1 + Math.max(WalletManager._genOf(vault), ...stored.map((c) => c.gen));
  }

  // The backup is the same vault written in the same call, so a damaged primary still has its twin. The write carries a
  // new generation: a write that stops between the two copies leaves the older one behind the newer (_openVault), so a
  // password change leaves no copy the old password opens. Returns the vault as stored.
  async _writeVault(vault) {
    const stored = { ...vault, gen: await this._nextGen(vault) };
    const s = JSON.stringify(stored);
    await AsyncStorage.multiSet([[WalletManager.VAULT_KEY, s], [WalletManager.VAULT_BACKUP_KEY, s]]);
    return stored;
  }

  _sealerFor(vault) {
    return vault && vault.hw ? deviceSealerFor(vault.hw) : null;
  }

  // Versions 1–3: the password alone (PBKDF2 → AES-256-GCM; version 1 is CryptoJS AES-CBC).
  async _decryptLegacy(vault, password) {
    const isHex = (h) => typeof h === 'string' && h.length > 0 && h.length % 2 === 0 && /^[0-9a-f]+$/i.test(h);
    if (vault.version === 3 || vault.version === 2) {
      if (!isHex(vault.salt) || !isHex(vault.iv) || !isHex(vault.encrypted)) throw new VaultFormatError();
      const iterations = vault.version === 3 ? WalletManager.VAULT_ITERATIONS_V3 : WalletManager.VAULT_ITERATIONS_V2;
      const key = await this._deriveKeyNative(password, vault.salt, iterations);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this._hexToBytes(vault.iv) }, key, this._hexToBytes(vault.encrypted));
      return Buffer.from(plain).toString('utf8');
    }
    if (vault.salt) return this._decryptCBC(vault, password);
    throw new VaultFormatError('Unsupported wallet format');
  }

  // One stored copy with the password. A wrong password throws an ordinary (counted) error. Once the password has
  // opened the data key, anything that still fails is damage, never the password: VaultCorruptError, uncounted
  // (MVA-R2-03). Damage found before the password is tried is a VaultFormatError, also uncounted.
  async _openCandidate(vault, password) {
    if (isVaultV4(vault)) {
      const dek = await unwrapWithPassword(vault, password, { hw: this._sealerFor(vault) });
      try {
        const dekKey = await aesKey(dek);
        const payload = await openPayload(vault, dekKey);
        JSON.parse(payload);
        return { vault, dekKey, payload, dek };
      } catch (e) {
        dek.fill(0);
        throw new VaultCorruptError();
      }
    }
    // A wrong CBC key yields garbage rather than throwing: the parse is the check.
    const legacy = JSON.parse(await this._decryptLegacy(vault, password));
    let upgraded;
    try {
      upgraded = await this._createWalletVault(legacy, password);
      await this._writeVault(upgraded.vault);
    } catch (e) {
      // The password was right; the device could not write the upgraded vault. Nothing changed on storage.
      throw Object.assign(new Error('The wallet could not be upgraded on this device'), { uncounted: true, cause: e });
    }
    return { vault: upgraded.vault, dekKey: upgraded.dekKey, payload: upgraded.payload, migratedFrom: vault.version || 1 };
  }

  // A new vault for a wallet object. The recovery phrase is sealed apart from the payload (Vault.withMnemonic),
  // so opening the wallet to sign never decrypts it.
  async _createWalletVault(wallet, password) {
    const data = { ...wallet };
    const mnemonic = data._tempMnemonic || data.mnemonic || null;
    delete data._tempMnemonic;
    delete data.mnemonic;
    delete data.password;
    const payload = JSON.stringify(data);
    const created = await createVault(payload, password, { hw: await deviceSealer() });
    const vault = mnemonic ? await withMnemonic(created.vault, created.dekKey, mnemonic) : created.vault;
    return { vault, dekKey: created.dekKey, payload };
  }

  /**
   * Opens the vault with the password: { vault, dekKey, payload, dek?, migratedFrom? }. A version 1–3 vault
   * is rewritten as version 4 on the spot. A copy that opens repairs the other. The caller zeroes `dek`.
   * Throws on a wrong password, DeviceKeyError when the device key that seals the vault is gone (`permanent`) or
   * did not answer this time (not `permanent`: try again), and VaultCorruptError when neither copy can be read.
   * The newest copy decides (_vaultCandidates): an older one (a write that stopped between the two copies) is tried only
   * when no newer copy took the password at all (damaged, or sealed by a device key that is gone). A password a newer
   * copy refused never opens an older one, whose repair would bring that older vault back over the newer (a changed
   * password undone by the old one).
   */
  async _openVault(password) {
    const candidates = await this._vaultCandidates({ all: true });
    if (candidates.length === 0) throw new Error('No wallet found');
    let lastError = null;
    let proven = false; // the password opened a copy whose contents are damaged
    let lostKey = null; // a copy the device key can never open again (MVA-R3-02)
    for (let i = 0; i < candidates.length; i++) {
      if (lastError && candidates[i].gen < candidates[0].gen) break;
      let opened;
      try {
        opened = await this._openCandidate(candidates[i].vault, password);
      } catch (e) {
        if (e instanceof DeviceKeyError) {
          // A Keystore that did not answer this time may answer the next: nothing else is tried or counted now.
          if (!e.permanent) throw e;
          lostKey = e;
          continue; // the other copy may still open
        }
        if (e instanceof VaultCorruptError) { proven = true; continue; }
        if (e instanceof VaultFormatError) continue;
        if (e && e.uncounted) throw e;
        lastError = e;
        continue;
      }
      // A copy opened: the password is right, and nothing after this point may count against it. Two copies that
      // differ (one damaged, or a write that stopped between them) both become the one that opened, at a new generation.
      if (candidates[i].fromBackup || candidates.length > 1) {
        opened.vault = await this._writeVault(opened.vault).catch(() => opened.vault); // repaired next time
      }
      if (opened.dek && !opened.vault.hw) opened.vault = await this._sealWithDeviceKey(opened, password);
      else if (opened.vault.hw === LEGACY_DEVICE_SEALER) opened.vault = await this._upgradeDeviceSeal(opened.vault);
      return opened;
    }
    // No copy the device key can open: not a wrong password, whatever another copy answered.
    if (lostKey) throw lostKey;
    // Every copy is damaged, or the password opened one whose contents are: not a wrong password.
    if (proven || !lastError) throw new VaultCorruptError();
    throw lastError;
  }

  /**
   * Android (MVA-R2-04): a vault written while the Keystore could not make a key (a probe that failed right after
   * boot, during the version 1–3 upgrade) carries the password wrap alone. Every password open tries again to seal
   * it with the device key, and keeps the unsealed vault when that still fails. Returns the vault now stored.
   */
  async _sealWithDeviceKey({ vault, dek }, password) {
    try {
      const hw = await deviceSealer();
      if (!hw) return vault;
      const sealed = await rewrapPassword(vault, dek, password, { hw });
      const check = await unwrapWithPassword(sealed, password, { hw });
      const same = check.length === dek.length && check.every((b, i) => b === dek[i]);
      check.fill(0);
      if (!same) return vault;
      await this._writeVault(sealed);
      return sealed;
    } catch (_) {
      return vault;
    }
  }

  /**
   * Android (MVA-R4-01): a vault sealed by the first device key (LEGACY_DEVICE_SEALER, made with an unlocked-device
   * requirement, which keystore2 on Android 12-14 deletes for good when the screen lock is removed) moves to the current
   * key at its next open, by password or biometrics. Only the seal around the password wrap changes: no password and no
   * data key are needed, and the round trip through the new key is checked first (Vault.resealDeviceWrap). It is
   * written only over the stored copies it was read from; once no stored copy names the legacy key, that key is
   * deleted. Any failure keeps the vault as it is, for the next open. Returns the vault now stored.
   */
  async _upgradeDeviceSeal(vault) {
    try {
      if (!isVaultV4(vault) || vault.hw !== LEGACY_DEVICE_SEALER) return vault;
      const from = deviceSealerFor(LEGACY_DEVICE_SEALER);
      const to = await deviceSealer();
      if (!from || !to || to.name === from.name) return vault;
      const next = await resealDeviceWrap(vault, from, to);
      const same = (raw) => {
        try {
          const v = JSON.parse(raw);
          return !!v && v.id === vault.id && v.hw === vault.hw && !!v.pw && v.pw.ct === vault.pw.ct
            && v.encrypted === vault.encrypted && JSON.stringify(v.bio || null) === JSON.stringify(vault.bio || null);
        } catch (_) {
          return false;
        }
      };
      const pairs = await AsyncStorage.multiGet([WalletManager.VAULT_KEY, WalletManager.VAULT_BACKUP_KEY]);
      if (!pairs.every(([, raw]) => !raw || same(raw))) return vault; // written meanwhile: left for the next open
      await this._writeVault(next);
      const left = (await this._vaultCandidates({ all: true })).some((c) => c.vault && c.vault.hw === LEGACY_DEVICE_SEALER);
      if (!left) await deleteLegacyDeviceKey();
      return next;
    } catch (_) {
      return vault;
    }
  }

  /**
   * A password wallet: 'sealed' when the device key (Android Keystore, iOS Secure Enclave) seals the vault's password
   * wrap, 'unsealed' when not; null for a wallet under the screen lock (a generated secret needs no warning about
   * guessable passwords).
   */
  async hardwareSealState() {
    if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || (await this.usesDeviceAuth())) return null;
    const candidates = await this._vaultCandidates().catch(() => []);
    const v4 = candidates.find((c) => isVaultV4(c.vault));
    if (!v4) return null;
    return v4.vault.hw ? 'sealed' : 'unsealed';
  }

  // The vault and its data key for a session token or a password.
  async _keyFor(credential) {
    if (WalletManager.isSessionToken(credential)) {
      const s = this._session;
      if (!s || s.token !== credential) throw new Error('The wallet is locked');
      const match = (await this._vaultCandidates()).find((c) => isVaultV4(c.vault) && c.vault.id === s.vaultId);
      if (!match) throw new Error('The wallet is locked');
      return { vault: match.vault, dekKey: s.dekKey };
    }
    // Anything else must be a typed password: a string (MVA-R4-03).
    if (typeof credential !== 'string' || !credential) throw new Error('The wallet is locked');
    const opened = await this._openVault(credential);
    if (opened.dek) opened.dek.fill(0);
    return opened;
  }

  async _payloadFor(credential) {
    if (WalletManager.isSessionToken(credential)) {
      const { vault, dekKey } = await this._keyFor(credential);
      return { vault, dekKey, payload: await openPayload(vault, dekKey) };
    }
    if (typeof credential !== 'string' || !credential) throw new Error('The wallet is locked');
    const opened = await this._openVault(credential);
    if (opened.dek) opened.dek.fill(0);
    return opened;
  }

  /**
   * 'none' | 'ok' | 'corrupt' | 'unreadable' — what is stored, without any password. Storage that cannot be read
   * right now is 'unreadable' (after a few quick retries), never 'none': "no wallet" leads to onboarding, where a
   * new wallet would take the place of the one that could not be read (MVA-R2-03).
   */
  async vaultState({ attempts = 3, retryMs = 300 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        return (await this._vaultCandidates()).length > 0 ? 'ok' : 'none';
      } catch (e) {
        if (e instanceof VaultCorruptError) return 'corrupt';
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    return 'unreadable';
  }

  // ── The one password check ──

  async _seedLimiter() {
    if (this._limiterSeeded) return;
    this._limiterSeeded = true;
    try {
      const raw = await AsyncStorage.getItem('qnet_rate_limit');
      if (!raw) return;
      await this._limiter.seed(JSON.parse(raw).attempts);
      await AsyncStorage.removeItem('qnet_rate_limit');
    } catch (e) {
      // The lockout could not be read right now: carry the old count over on a later call.
      if (e && e.notNow) this._limiterSeeded = false;
    }
  }

  async getPasswordLockStatus() {
    await this._seedLimiter();
    return this._limiter.status();
  }

  // Runs `open` (which throws on a wrong password) under the lockout. Only a non-empty string is a password: a session
  // token (an object) never is.
  async _checked(password, open) {
    if (typeof password !== 'string' || !password) return { ok: false, locked: false, remainingMs: 0 };
    await this._seedLimiter();
    return this._limiter.check(async () => { await open(); return true; });
  }

  /**
   * What the screen passes where a password goes when the vault secret is to be read behind a fresh device
   * authentication with the prompt `reason`. The secret itself never reaches the screen (MVA-R3-03).
   */
  static deviceAuthCredential(reason) {
    return Object.freeze({ [DEVICE_AUTH_CRED]: String(reason || '') });
  }

  static isDeviceAuthCredential(x) {
    return !!x && typeof x === 'object' && DEVICE_AUTH_CRED in x;
  }

  /**
   * Opens the vault under the lockout, with a typed password or a device-auth credential: { r, opened, secret,
   * deviceAuth }. A refused or cancelled prompt is { r: { ok: false, cancelled: true } } and counts nothing. The
   * stored item may hold two secrets while a rotation is under way (see _rotateVaultSecret): one check, and
   * whichever of them opens the stored vault is the one kept.
   */
  async _openChecked(credential) {
    if (!WalletManager.isDeviceAuthCredential(credential)) {
      let opened = null;
      const r = await this._checked(credential, async () => { opened = await this._openVault(credential); });
      return { r, opened, secret: r.ok ? credential : null, deviceAuth: false };
    }
    const item = await this._deviceAuthItem(credential[DEVICE_AUTH_CRED] || tr('bio_prompt_unlock'));
    if (!item.ok) {
      // Refused: nothing counted. Gone: the screen lock that kept the secret was removed; only the recovery phrase
      // opens this wallet now. Failed: the next try may work; `notNow` when iOS refused it only because the app was not
      // in front (MA-R2-02).
      const why = item.reason === 'gone' ? { gone: true }
        : item.reason === 'failed' ? (item.notNow ? { failed: true, notNow: true } : { failed: true }) : { cancelled: true };
      return { r: { ok: false, ...why }, opened: null, secret: null, deviceAuth: true };
    }
    const secrets = WalletManager._secretsOf(item.secret);
    let opened = null;
    let used = null;
    const r = await this._checked(secrets[0], async () => {
      let last = null;
      for (const s of secrets) {
        try {
          opened = await this._openVault(s);
          used = s;
          return;
        } catch (e) {
          if (e && e.uncounted) throw e;
          last = e;
        }
      }
      throw last || new Error('No vault secret');
    });
    if (!r.ok) return { r, opened, secret: null, deviceAuth: true };
    const staging = WalletManager._stagingOf(item.secret);
    if (staging && staging.move && used === staging.current) {
      // A move from a password that stopped before its vault write: the typed password opened the vault. The move ends
      // here, so the password is never kept as the secret behind the screen lock (MA-4).
      const moved = await this._finishMoveToDeviceAuth(opened, staging.next);
      if (moved) return { r, opened: moved, secret: staging.next, deviceAuth: true };
      return { r, opened, secret: used, deviceAuth: true };
    }
    await this._settleDeviceAuthItem(item, used);
    return { r, opened, secret: used, deviceAuth: true };
  }

  /** { ok } or { ok: false, locked, remainingMs, attempts } or { ok: false, cancelled } (a refused prompt). */
  async checkPassword(password) {
    const { r, opened } = await this._openChecked(password);
    if (opened && opened.dek) opened.dek.fill(0);
    return r;
  }

  async verifyPassword(password) {
    return (await this.checkPassword(password)).ok === true;
  }

  /** Unlock with the password (or a device-auth credential): { ok, token } or the lockout status. */
  async unlockWithPassword(password) {
    const { r, opened, secret, deviceAuth } = await this._openChecked(password);
    if (!r.ok) return r;
    return this._finishUnlock(opened, secret, deviceAuth);
  }

  // A password wallet opened with its password or its biometric wrap: a screen-lock staging item a move left before its
  // flag went up (the app stopped between the two) holds the password, and goes (MA-4). A wallet under the screen lock
  // keeps its items, and so does one whose flag cannot be read now.
  async _dropStrayStaging() {
    try {
      if ((await this.deviceAuthState({ attempts: 2, retryMs: 100 })) !== 'no') return;
      await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE);
    } catch (_) { /* the next unlock tries again */ }
  }

  // A vault just opened under the lockout becomes the session. Owed rotations run first, while the data key is
  // still here; a failed one keeps the vault as it was and is tried again at the next unlock.
  async _finishUnlock(opened, secret, deviceAuth = false) {
    if (!deviceAuth) await this._dropStrayStaging();
    let { dekKey } = opened;
    let rekeyed = false;
    try {
      // Owed after the biometric key was invalidated (MVA-R2-06): a data key that crossed to the native prompt
      // opens nothing written from now on.
      if (isVaultV4(opened.vault) && (await AsyncStorage.getItem(WalletManager.DEK_ROTATE_KEY).catch(() => null)) === '1') {
        try {
          ({ dekKey } = await this._rotateDek(opened, secret));
          rekeyed = true;
          await AsyncStorage.removeItem(WalletManager.DEK_ROTATE_KEY);
        } catch (e) {
          // The stored vault is the one that just opened (nothing was written, or all of it was): the flag stays and
          // the next unlock tries again. Said in the log, never silent (MVA-R5-01).
          logger.warn('[WARN][VAULT] owed data-key rotation failed; retried at the next unlock', (e && (e.code || e.name)) || 'error');
        }
      }
      if (deviceAuth && !rekeyed && opened.dek && isVaultV4(opened.vault)) {
        await this._maybeRotateVaultSecret(opened, secret);
      }
    } finally {
      if (opened.dek) opened.dek.fill(0);
    }
    return { ok: true, token: this._openSession(dekKey, opened.vault.id), migratedFrom: opened.migratedFrom || null };
  }

  /**
   * The recovery phrase, behind a fresh password check (or a device-auth credential: the secret is read behind a fresh
   * device authentication here). This is the only place the phrase is decrypted after the wallet is created.
   * { ok, mnemonic } or the refusal ({ cancelled } for a refused prompt).
   */
  async revealMnemonic(password) {
    const { r, opened } = await this._openChecked(password);
    if (!r.ok) return r;
    if (opened.dek) opened.dek.fill(0);
    const mnemonic = (await openMnemonic(opened.vault, opened.dekKey)) || JSON.parse(opened.payload).mnemonic || null;
    return { ok: true, mnemonic };
  }

  /**
   * The wallet's private keys, behind the same fresh check as the recovery phrase (Settings → Export private key):
   * { ok, qnet: { address, key }, solana: { address, key } }, or the refusal ({ cancelled } for a refused prompt).
   * The QNet key is the compact form the wallet key is made from: the 32-byte ML-DSA-65 key-generation seed,
   * SHAKE-256 of the canonical seed string (WalletIdentity.walletSeedString), as 64 hex characters; any FIPS 204
   * implementation rebuilds the key pair from it. The Solana key is the 64-byte secret key (seed and public key) in
   * base58. Each is handed over only after the key it makes is checked to give the wallet's address; a key that cannot
   * be made or checked (a wallet without its recovery phrase, an address that does not match) is null. Nothing here is
   * stored, logged or sent.
   */
  // `which`: 'qnet' or 'solana' derives and gives that account's key only (the screen asks which first); none: both.
  async revealPrivateKeys(credential, which = null) {
    const { r, opened } = await this._openChecked(credential);
    if (!r.ok) return r;
    if (opened.dek) opened.dek.fill(0);
    const wallet = JSON.parse(opened.payload);
    const phrase = (await openMnemonic(opened.vault, opened.dekKey).catch(() => null)) || wallet.mnemonic || null;
    const out = {
      ok: true,
      qnet: { address: wallet.qnetAddress || null, key: null },
      solana: { address: wallet.solanaAddress || wallet.address || null, key: null },
    };
    const wants = (account) => which !== 'qnet' && which !== 'solana' ? true : which === account;
    let seed = null;
    try {
      if (phrase) seed = bip39.mnemonicToSeedSync(phrase);
      if (seed && out.qnet.address && wants('qnet')) out.qnet.key = WalletManager.qnetKeySeedHex(seed, out.qnet.address);
      if (wants('solana')) out.solana.key = await this._solanaSecretBase58(wallet, seed, out.solana.address);
    } finally {
      if (seed) seed.fill(0);
      if (Array.isArray(wallet.secretKey)) wallet.secretKey.fill(0);
      if (wallet.qnetKeypair && Array.isArray(wallet.qnetKeypair.privateKey)) wallet.qnetKeypair.privateKey.fill(0);
    }
    return out;
  }

  /**
   * The 32-byte ML-DSA-65 key-generation seed of the QNet wallet key made from the 64-byte recovery-phrase `seed`, as
   * hex — only when the key pair FIPS 204 makes from it gives `address`, else null.
   */
  static qnetKeySeedHex(seed, address) {
    const xi = shake256(utf8ToBytes(walletSeedString(seed)), { dkLen: 32 });
    let pair = null;
    try {
      pair = ml_dsa65.keygen(xi);
      return eonFromPublicKeyBytes(pair.publicKey) === address ? bytesToHex(xi) : null;
    } catch (_) {
      return null;
    } finally {
      xi.fill(0);
      if (pair && pair.secretKey) pair.secretKey.fill(0);
    }
  }

  // The Solana secret key in base58: the stored one, or the one the recovery phrase makes on m/44'/501'/0'/0' when none
  // is stored; null unless it gives `address`.
  async _solanaSecretBase58(wallet, seed, address) {
    let secret = null;
    try {
      if (Array.isArray(wallet.secretKey) && wallet.secretKey.length === 64) {
        secret = Uint8Array.from(wallet.secretKey);
      } else if (seed) {
        const derived = await this.deriveHDKeypair(seed, 0);
        secret = Keypair.fromSeed(derived).secretKey;
        derived.fill(0);
      }
      if (!secret || !address) return null;
      const pair = Keypair.fromSecretKey(secret); // refuses a secret key whose two halves do not belong together
      return pair.publicKey.toBase58() === address ? base58Encode(secret) : null;
    } catch (_) {
      return null;
    } finally {
      if (secret) secret.fill(0);
    }
  }

  // ── Biometrics and device authentication ──

  // A password wallet's optional biometric unlock (Android: the per-use biometric key). A wallet under the screen
  // lock has no such option: the screen lock already offers the biometric.
  async isBiometricSupported() {
    if (await this.usesDeviceAuth()) return false;
    return biometricKeyAvailable();
  }

  async getBiometryType() {
    try {
      return await Keychain.getSupportedBiometryType();
    } catch { return null; }
  }

  async isBiometricEnabled() {
    try {
      // Under the screen lock the stored item itself is behind the prompt, so its presence is tracked by the flag —
      // reading it here would raise the prompt on every launch.
      if (await this.usesDeviceAuth()) return true;
      // A password wallet: only the vault's biometric wrap (a key that needs a strong biometric per use and dies when
      // one is enrolled) counts. An older build's item is never read (purgeLegacyBiometric).
      const candidates = await this._vaultCandidates().catch(() => []);
      return candidates.some((c) => isVaultV4(c.vault) && c.vault.bio);
    } catch { return false; }
  }

  static LEGACY_BIO_NOTICE_KEY = 'qnet_bio_reenroll_notice';

  /**
   * Android, every launch before anything reads biometric state: builds before 1.2.0 kept the wallet PASSWORD
   * itself in the Keychain behind a fingerprint key with a 5-second validity window that a newly enrolled
   * fingerprint does not invalidate (react-native-keychain 8, RSA). That item is unsafe on sight: it is
   * deleted with its Keystore key and never read. When the vault has no biometric wrap of its own, biometric
   * unlock is off from now on and a notice asks the user to turn it on again (enableBiometricUnlock, the
   * per-use key). Returns true when it removed such an item.
   */
  async purgeLegacyBiometric() {
    // iOS keeps an older build's vault secret under this service; only a password wallet can have the unsafe item.
    if (Platform.OS !== 'android' || (await this.usesDeviceAuth())) return false;
    let legacy = false;
    try {
      legacy = !!(await Keychain.hasGenericPassword({ service: WalletManager.KEYCHAIN_SERVICE }));
    } catch (_) { legacy = false; }
    if (!legacy) return false;
    try { await Keychain.resetGenericPassword({ service: WalletManager.KEYCHAIN_SERVICE }); } catch (_) { /* retried next launch */ }
    const candidates = await this._vaultCandidates().catch(() => []);
    if (!candidates.some((c) => isVaultV4(c.vault) && c.vault.bio) && candidates.length > 0) {
      await AsyncStorage.setItem(WalletManager.LEGACY_BIO_NOTICE_KEY, '1').catch(() => {});
    }
    return true;
  }

  /** Whether the "turn biometric unlock on again" notice is owed; `clear` marks it shown. */
  async legacyBiometricNotice({ clear = false } = {}) {
    try {
      const owed = (await AsyncStorage.getItem(WalletManager.LEGACY_BIO_NOTICE_KEY)) === '1';
      if (owed && clear) await AsyncStorage.removeItem(WalletManager.LEGACY_BIO_NOTICE_KEY);
      return owed;
    } catch (_) {
      return false;
    }
  }

  /**
   * A new wallet under the screen lock: its generated vault secret goes behind the screen lock (DeviceAuthStore) and is
   * read back through it once (the prompt `prompt`), so no wallet is written that its own screen lock could not open
   * after the first lock (MA-6). Only for a wallet about to be written: the stored item is the one secret that opens a
   * stored vault, so it is never replaced while one is there (or while storage cannot tell). 'ok', 'cancelled' (the
   * prompt was refused: nothing kept, try again), 'retry' (the prompt or the Keystore failed this time: nothing kept,
   * try again), 'failed' (the device took the secret and could not give it back: it counts as a device without a screen
   * lock from now on, and a new wallet gets a password; _readBackVerdict) or 'unavailable' (the device has no usable
   * screen lock: the next attempt asks for a password). Only a definite no is 'unavailable', since the screen then says
   * the wallet will ask for a password: storage that could not be read, a check the device did not answer and a write it
   * refused for any reason but a missing screen lock are 'retry' (MA-R2-04).
   */
  async _protectNewSecret(secret, prompt) {
    if (!(await this.canStoreNewWallet())) return 'retry'; // checked just before; storage that cannot be read now
    const avail = await this._deviceAuthAvailability();
    if (avail === 'no') return 'unavailable';
    if (avail !== 'yes') return 'retry';
    try {
      await writeDeviceAuth(WalletManager.DEVICE_AUTH_SERVICE, secret);
    } catch (e) {
      // Refused: the screen lock went meanwhile (the device says so when asked again), or the device failed for now.
      if (e && e.code === 'NOT_SET') return 'unavailable';
      return (await this._deviceAuthAvailability()) === 'no' ? 'unavailable' : 'retry';
    }
    const back = await readDeviceAuth([WalletManager.DEVICE_AUTH_SERVICE], prompt || tr('auth_device_unlock'));
    const verdict = WalletManager._readBackVerdict(back, (s) => s === secret);
    if (verdict !== 'ok') {
      await removeDeviceAuth(WalletManager.DEVICE_AUTH_SERVICE).catch(() => {});
      if (verdict === 'broken') {
        await this._markDeviceAuthBroken();
        return 'failed';
      }
      return verdict; // 'cancelled' or 'retry': nothing kept, and the next attempt may use the screen lock again
    }
    await this._deviceAuthWorks();
    await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
    await Keychain.resetGenericPassword({ service: WalletManager.KEYCHAIN_SERVICE }).catch(() => {});
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now())).catch(() => {});
    return 'ok';
  }

  // Android's read-back failures that say this device's screen-lock path cannot give a secret back (MA-6): the prompt
  // passed and the key still did not open it (UserNotAuthenticated, a Keystore error, a blob that does not open). The
  // native module answers these only after the prompt; a failure before it is PRE_PROMPT (SecurityModule devAuthOpen).
  // Every other failure (a timeout, the sensor unavailable, a busy Keystore, no screen to show the prompt on, anything
  // before the prompt) is for now.
  static DEVICE_AUTH_BROKEN_CODES = new Set(['DEVICE_LOCKED', 'KEYSTORE', 'KEY_MISMATCH']);

  /**
   * What a read-back through the screen lock tells (`matches(secret)` says whether what came back is the secret written):
   * 'ok'; 'cancelled' (the prompt was refused); 'retry' (it failed this time: a prompt or Keystore error that a later
   * try may not meet, and any iOS error with the item still there); 'broken' (the device took the secret and cannot give
   * it back: it came back different, the item reads as gone at once, or Android failed after the prompt passed).
   */
  static _readBackVerdict(back, matches) {
    if (back && back.ok) return matches(back.secret) ? 'ok' : 'broken';
    const reason = back && back.reason;
    if (reason === 'cancelled') return 'cancelled';
    if (reason === 'failed') {
      if (Platform.OS !== 'android') return 'retry';
      return WalletManager.DEVICE_AUTH_BROKEN_CODES.has(String(back.code || '')) ? 'broken' : 'retry';
    }
    return 'broken';
  }

  // For DEVICE_AUTH_BROKEN_MS this device counts as one without a usable screen lock: a new wallet gets a password (MA-6).
  async _markDeviceAuthBroken() {
    await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_BROKEN_KEY, String(Date.now())).catch(() => {});
  }

  // A read-back through the screen lock worked: the path works on this device, whatever an earlier failure marked.
  async _deviceAuthWorks() {
    await AsyncStorage.removeItem(WalletManager.DEVICE_AUTH_BROKEN_KEY).catch(() => {});
  }

  /** As _protectNewSecret: true when the secret is behind the screen lock and read back. */
  async enableDeviceAuthUnlock(secret, prompt) {
    return (await this._protectNewSecret(secret, prompt)) === 'ok';
  }

  /**
   * A password wallet's biometric unlock (Android): the vault's data key is wrapped by a Keystore key that needs a
   * strong biometric for every use and dies when one is enrolled. The password itself is never stored.
   */
  async enableBiometricUnlock(password) {
    try {
      if (await this.usesDeviceAuth()) return false;
      const bio = biometricSealer({ title: tr('bio_prompt_enable'), subtitle: tr('qnet_wallet'), cancel: tr('bio_use_password') });
      if (!bio || !(await biometricKeyAvailable())) return false;
      let opened = await this._openVault(password);
      if (!opened.dek) opened = await this._openVault(password); // migrated just now: open the new vault
      try {
        await this._writeVault(await withBioWrap(opened.vault, opened.dek, bio));
      } finally {
        opened.dek.fill(0);
      }
      await Keychain.resetGenericPassword({ service: WalletManager.KEYCHAIN_SERVICE }).catch(() => {});
      return true;
    } catch { return false; }
  }

  // A password wallet's biometric unlock off. A wallet under the screen lock is left as it is: its stored secret is
  // the one thing that opens it.
  async disableBiometricUnlock() {
    try {
      if (await this.usesDeviceAuth()) return false;
      await Keychain.resetGenericPassword({ service: WalletManager.KEYCHAIN_SERVICE });
      const withBio = (await this._vaultCandidates().catch(() => [])).find((c) => isVaultV4(c.vault) && c.vault.bio);
      if (withBio) await this._writeVault(withoutBioWrap(withBio.vault));
      await deleteBiometricKey();
      return true;
    } catch { return false; }
  }

  _writeDeviceAuthSecret(secret) {
    return writeDeviceAuth(WalletManager.DEVICE_AUTH_SERVICE, secret);
  }

  // { ok: true, secret, service } behind one fresh device authentication, or { ok: false, reason } (DeviceAuthStore.read,
  // in the order of DEVICE_AUTH_SERVICES; a missing item is passed over without a prompt). The only way to the vault
  // secret: the screen passes deviceAuthCredential and never holds it (MVA-R3-03).
  async _deviceAuthItem(title) {
    const item = await readDeviceAuth(WalletManager.DEVICE_AUTH_SERVICES, title);
    if (item && item.ok) await this._deviceAuthWorks();
    return item;
  }

  // A staging item: { current, next, move } of {"v":1,"s":current,"n":next} (a rotation), with "m":1 when it is a move
  // from a password ("s" is then the typed password, never to be kept); null for any other item.
  static _stagingOf(raw) {
    const text = String(raw || '');
    if (!text.startsWith('{')) return null;
    try {
      const o = JSON.parse(text);
      const str = (x) => (typeof x === 'string' && x.length > 0 ? x : null);
      if (!o || (!str(o.n) && !str(o.s))) return null;
      return { current: str(o.s), next: str(o.n), move: o.m === 1 };
    } catch (_) {
      return null;
    }
  }

  // The secrets an item holds, the one to try first first: a staging item's next, then its current; every other item is
  // the secret itself.
  static _secretsOf(raw) {
    const staging = WalletManager._stagingOf(raw);
    if (staging) return [staging.next, staging.current].filter(Boolean);
    return [String(raw || '')];
  }

  // After `secret` opened the vault: it is written as the current item unless that is already what the item read
  // holds, and only then does the item it came from (a rotation's staging item, an older build's) go. A write that
  // fails leaves every item as it was; the next unlock settles it.
  async _settleDeviceAuthItem(item, secret) {
    if (!item || !secret) return;
    if (item.service === WalletManager.DEVICE_AUTH_SERVICE && item.secret === secret) return;
    try {
      await this._writeDeviceAuthSecret(secret);
      if (item.service !== WalletManager.DEVICE_AUTH_SERVICE) await removeDeviceAuth(item.service);
    } catch (_) { /* the next unlock tries again */ }
  }

  static VAULT_SECRET_AT_KEY = 'qnet_vault_secret_at';
  static VAULT_SECRET_MAX_AGE_MS = 24 * 3600_000;

  /**
   * iOS (MVA-R3-03): the vault secret crosses into JavaScript at every unlock, where a string cannot be zeroed. It is
   * replaced at the first unlock a day after the last replacement, so a copy of it taken from memory stops opening
   * the vault stored after that. A wallet with no date yet starts the clock.
   */
  async _maybeRotateVaultSecret(opened, current) {
    try {
      const now = Date.now();
      const at = Number(await AsyncStorage.getItem(WalletManager.VAULT_SECRET_AT_KEY));
      if (!Number.isFinite(at) || at <= 0 || at > now) {
        await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(now));
        return;
      }
      if (now - at < WalletManager.VAULT_SECRET_MAX_AGE_MS) return;
      await this._rotateVaultSecret(opened, current);
    } catch (_) { /* the next unlock tries again */ }
  }

  /**
   * A new vault secret for the opened vault: the same data key is wrapped for it, and the payload, the recovery
   * phrase and every sealed record stay as they are, so the one vault write cannot leave a record behind (iOS
   * AsyncStorage writes a multiSet key by key). The store never holds fewer secrets than can open what is stored:
   *   1. the staging item takes both secrets (the current item is untouched);
   *   2. the vault is written wrapped for the new secret, after a round trip proves it opens;
   *   3. the current item takes the new secret (a write replaces an item by deleting it first);
   *   4. the staging item goes.
   * Stopping anywhere leaves the staging item, which _deviceAuthItem reads first and which opens either vault.
   */
  async _rotateVaultSecret(opened, current) {
    const next = this.generateVaultPassword();
    await writeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE, JSON.stringify({ v: 1, s: current, n: next }));
    const hw = this._sealerFor(opened.vault);
    const rewrapped = await rewrapPassword(opened.vault, opened.dek, next, { hw });
    const check = await unwrapWithPassword(rewrapped, next, { hw });
    const same = check.length === opened.dek.length && check.every((b, i) => b === opened.dek[i]);
    check.fill(0);
    if (!same) {
      await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
      return;
    }
    await this._writeVault(rewrapped);
    opened.vault = rewrapped;
    // The stored vault has the new secret from here on: the clock restarts now, so an unlock that settles a staging
    // item left by a failed step 3 does not rotate again.
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now())).catch(() => {});
    await this._writeDeviceAuthSecret(next);
    await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
  }

  /**
   * A password wallet moves to the screen lock (it may, never must). The password is checked under the lockout; a
   * generated secret goes behind the screen lock and is read back through it (one prompt, `prompt`); the vault gets a
   * fresh data key sealed for that secret (as a password change, MVA-R2-06), and biometric unlock by the biometric
   * key ends, since the screen lock now offers it. Crash-safe in the same way as a rotation: the staging item holds the
   * password and the new secret until the current item has the secret, and the flag goes up before the vault changes.
   * { ok } or { ok: false, locked, remainingMs } | { ok: false, cancelled } | { ok: false, unavailable }.
   */
  async switchToDeviceAuth(password, prompt) {
    if ((await this.usesDeviceAuth()) || !(await this.deviceAuthAvailable())) return { ok: false, unavailable: true };
    let opened = null;
    const r = await this._checked(password, async () => { opened = await this._openVault(password); });
    if (!r.ok) return r;
    if (!opened.dek) opened = await this._openVault(password); // migrated just now: open the new vault
    const secret = this.generateVaultPassword();
    try {
      try {
        // "m": a move: the password in "s" is only ever used to open the vault once (_openChecked finishes the move).
        await writeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE, JSON.stringify({ v: 1, s: password, n: secret, m: 1 }));
      } catch (_) {
        return { ok: false, unavailable: true }; // nothing changed
      }
      const back = await readDeviceAuth([WalletManager.DEVICE_AUTH_NEXT_SERVICE], prompt);
      const refused = await this._moveReadBackRefused(back, secret);
      if (refused) return refused;
      const hadBio = !!opened.vault.bio;
      await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_FLAG, '1');
      await this._rotateDek(opened, secret);
      await this._finishSwitch(secret, hadBio);
      return { ok: true };
    } finally {
      if (opened && opened.dek) opened.dek.fill(0);
    }
  }

  // A move's read-back that did not give the new secret back: the staging item goes, and the answer for the caller, or
  // null when it did. A prompt that cannot give the secret back (not a refusal, not a failure for now): this device's
  // screen lock path does not work, so it counts as one without a screen lock and no unlock asks again (MA-6).
  async _moveReadBackRefused(back, secret) {
    const verdict = WalletManager._readBackVerdict(back, (s) => WalletManager._secretsOf(s).includes(secret));
    if (verdict === 'ok') {
      await this._deviceAuthWorks();
      return null;
    }
    await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
    if (verdict === 'cancelled') return { ok: false, cancelled: true };
    if (verdict === 'broken') await this._markDeviceAuthBroken();
    return { ok: false, unavailable: true };
  }

  // After a move's vault write: the current item takes the secret, the staging item goes, and biometric unlock by the
  // biometric key ends (the screen lock offers it now).
  async _finishSwitch(secret, hadBio) {
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now())).catch(() => {});
    await this._writeDeviceAuthSecret(secret);
    await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
    await AsyncStorage.removeItem(WalletManager.DEK_ROTATE_KEY).catch(() => {});
    if (hadBio) await deleteBiometricKey();
  }

  /**
   * As switchToDeviceAuth, for a password wallet that unlocks with its biometric wrap (Android): a fresh strong biometric
   * through the CryptoObject-bound prompt (`bioReason`; the same check a biometric unlock passes, and no device
   * credential stands in for it) gives the vault's data key, which is all the move needs, so no password is typed. So the
   * wallet moves at a biometric unlock as it does at a password unlock (O2, D1), and an open session alone moves nothing.
   * Crash-safe without the password: the staging item holds only the new secret, and the flag goes up in the same storage
   * write as the vault sealed for that secret (Android's AsyncStorage writes a multiSet in one database transaction), so
   * no stored state has the flag without a vault the staging item opens, or such a vault without the flag. Android only.
   * { ok } | { ok: false, cancelled } | { ok: false, invalidated } | { ok: false, unavailable }.
   */
  async switchToDeviceAuthWithBiometric(prompt, bioReason) {
    if (Platform.OS !== 'android') return { ok: false, unavailable: true };
    if ((await this.deviceAuthState()) !== 'no' || !(await this.deviceAuthAvailable())) return { ok: false, unavailable: true };
    const withBio = (await this._vaultCandidates().catch(() => [])).find((c) => isVaultV4(c.vault) && c.vault.bio);
    if (!withBio) return { ok: false, unavailable: true };
    let opened;
    let dek;
    try {
      dek = await unwrapWithBio(withBio.vault, biometricSealer({ title: bioReason, cancel: tr('bio_use_password'), confirm: true }));
    } catch (e) {
      if (e && (e.code === 'KEY_INVALIDATED' || e.code === 'KEY_MISSING')) {
        await this.disableBiometricUnlock();
        await AsyncStorage.setItem(WalletManager.DEK_ROTATE_KEY, '1').catch(() => {});
        return { ok: false, invalidated: true };
      }
      return { ok: false, cancelled: true };
    }
    try {
      const dekKey = await aesKey(dek);
      opened = { vault: withBio.vault, dekKey, payload: await openPayload(withBio.vault, dekKey) };
    } finally {
      dek.fill(0);
    }
    const secret = this.generateVaultPassword();
    try {
      await writeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE, JSON.stringify({ v: 1, n: secret }));
    } catch (_) {
      return { ok: false, unavailable: true }; // nothing changed
    }
    const back = await readDeviceAuth([WalletManager.DEVICE_AUTH_NEXT_SERVICE], prompt);
    const refused = await this._moveReadBackRefused(back, secret);
    if (refused) return refused;
    await this._rotateDek(opened, secret, [[WalletManager.DEVICE_AUTH_FLAG, '1']]);
    await this._finishSwitch(secret, true);
    return { ok: true };
  }

  /**
   * The end of a move from a password that stopped after its flag went up (the vault still opens with the password):
   * the vault gets a fresh data key sealed for the move's generated secret `next`, which then becomes the current item,
   * and the staging item that held the password goes. The opened vault for the session, or null when it could not be
   * done now (everything stays as it was; the next unlock tries again).
   */
  async _finishMoveToDeviceAuth(opened, next) {
    if (!next || !opened || !opened.dek || !isVaultV4(opened.vault)) return null;
    try {
      const rotated = await this._rotateDek(opened, next);
      await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now())).catch(() => {});
      await this._writeDeviceAuthSecret(next);
      await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
      await AsyncStorage.removeItem(WalletManager.DEK_ROTATE_KEY).catch(() => {});
      opened.dek.fill(0);
      return { ...opened, vault: rotated.vault, dekKey: rotated.dekKey, dek: null };
    } catch (e) {
      logger.warn('[WARN][VAULT] move to the screen lock not finished; retried at the next unlock', (e && (e.code || e.name)) || 'error');
      return null;
    }
  }

  /**
   * A wallet under the screen lock whose secret is gone (deviceAuthSecretState 'gone'), while it is still open: the
   * open session's data key is the only way left to it, so the vault gets a fresh data key sealed for a new wallet
   * password, and the wallet opens with that password from now on. Whoever removed the screen lock proved the device
   * credential to do it, so this asks for no more than a send would have. Crash-safe: a vault written before the flag
   * went is settled as moved (_settlePasswordMove). { ok } or throws (the password is too short, or the write failed:
   * nothing changed).
   */
  async reprotectWithPassword(token, newPassword) {
    await WalletManager._assertNewPassword(newPassword);
    if (!(await this.usesDeviceAuth())) throw Object.assign(new Error('Not a wallet under the screen lock'), { code: 'NOT_DEVICE_AUTH' });
    const opened = await this._payloadFor(token);
    await AsyncStorage.setItem(WalletManager.PASSWORD_MOVE_KEY, JSON.stringify({ from: opened.vault.pw.ct }));
    try {
      await this._rotateDek(opened, newPassword);
    } catch (e) {
      // The marker goes only once the stored copies say whether the new wrap is there (MA-R3-01); unread, it stays.
      await this._settlePasswordMove().catch(() => {});
      throw e;
    }
    await AsyncStorage.removeItem(WalletManager.DEVICE_AUTH_FLAG);
    await AsyncStorage.removeItem(WalletManager.PASSWORD_MOVE_KEY).catch(() => {});
    for (const s of [WalletManager.DEVICE_AUTH_SERVICE, WalletManager.DEVICE_AUTH_NEXT_SERVICE]) {
      await removeDeviceAuth(s).catch(() => {});
    }
    await AsyncStorage.multiRemove([WalletManager.DEK_ROTATE_KEY, WalletManager.VAULT_SECRET_AT_KEY]).catch(() => {});
    return { ok: true };
  }

  /**
   * As reprotectWithPassword, on a device whose screen lock is on again: a new generated secret goes behind the new
   * screen lock and is read back through it (one prompt, `prompt`) before the vault gets a fresh data key sealed for
   * it. { ok } | { ok: false, cancelled } | { ok: false, unavailable } (the prompt failed this time, or the device
   * cannot give a secret back: then it also counts as one without a usable screen lock, _readBackVerdict).
   */
  async reprotectWithDeviceAuth(token, prompt) {
    if (!(await this.usesDeviceAuth()) || !(await this.deviceAuthAvailable())) return { ok: false, unavailable: true };
    const opened = await this._payloadFor(token);
    const secret = this.generateVaultPassword();
    try {
      await writeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE, JSON.stringify({ v: 1, n: secret }));
    } catch (_) {
      return { ok: false, unavailable: true };
    }
    const back = await readDeviceAuth([WalletManager.DEVICE_AUTH_NEXT_SERVICE], prompt);
    const refused = await this._moveReadBackRefused(back, secret);
    if (refused) return refused;
    await this._rotateDek(opened, secret);
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now())).catch(() => {});
    await this._writeDeviceAuthSecret(secret);
    await removeDeviceAuth(WalletManager.DEVICE_AUTH_NEXT_SERVICE).catch(() => {});
    await AsyncStorage.removeItem(WalletManager.DEK_ROTATE_KEY).catch(() => {});
    return { ok: true };
  }

  /**
   * iOS (MVA-R2-05): items an older build wrote sit in the Keychain group named after another bundle id
   * (TEAMID.com.qnet.mobile), which any app of the team with that id could read. Items that need no authentication
   * (the lockout, the light node's ping keys) are written again at launch: a write without a group deletes every
   * copy the app can reach and adds the item to the entitlement's first group, now the app's own. The vault secret
   * moves at the next unlock (unlockWithBiometrics). The old group stays in the entitlement until a later release,
   * so nothing becomes unreachable meanwhile.
   */
  async migrateKeychainGroup() {
    if (Platform.OS !== 'ios') return;
    try {
      if ((await AsyncStorage.getItem(KEYCHAIN_GROUP_MOVED_KEY)) === '1') return;
      const services = (await Keychain.getAllGenericPasswordServices({ skipUIAuth: true })) || [];
      for (const service of services) {
        let accessible = null;
        if (service === LIMITER_SERVICE) accessible = Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
        else if (service.startsWith('qnet_ping_sk_')) accessible = Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
        if (!accessible) continue;
        const item = await Keychain.getGenericPassword({ service });
        if (item && item.password) await Keychain.setGenericPassword(item.username, item.password, { service, accessible });
      }
      await AsyncStorage.setItem(KEYCHAIN_GROUP_MOVED_KEY, '1');
    } catch (_) { /* the next launch tries again */ }
  }

  /**
   * Android (MPLAT-R4-01): a fresh check of whoever holds the phone for a send, an approval or a security change,
   * through the system BiometricPrompt bound to the vault's biometric key (a CryptoObject): an accessibility service can
   * neither see nor pass it, unlike a typed password it may watch or type. Only for the open session's vault, and only
   * where biometric unlock is set up. The key it opens must be the vault's own data key (the stored payload opens with
   * it). { ok: true }, or { ok: false, fallback: true }: no biometric wrap, the key is gone or was invalidated (then
   * biometric unlock turns off, as at unlock), or the prompt was left (its button is "Use password"): the caller asks for
   * the password instead. `note` is shown on the prompt (the apps that can read the screen, when there are any), and
   * `detail` is what the approval approves (a send's recipient), which the system draws where no app can change it
   * (MPLAT-R5-01). The prompt needs a deliberate press after a passive face match (MVA-R5-02).
   */
  async confirmWithBiometrics(reason, note = '', detail = '') {
    const fallback = { ok: false, fallback: true };
    const s = this._session;
    if (Platform.OS !== 'android' || !s || (await this.usesDeviceAuth())) return fallback;
    const withBio = (await this._vaultCandidates().catch(() => []))
      .find((c) => isVaultV4(c.vault) && c.vault.bio && c.vault.id === s.vaultId);
    if (!withBio) return fallback;
    let dek;
    try {
      dek = await unwrapWithBio(withBio.vault, biometricSealer({
        title: reason, subtitle: note, description: detail, cancel: tr('bio_use_password'), confirm: true,
      }));
    } catch (e) {
      if (e && (e.code === 'KEY_INVALIDATED' || e.code === 'KEY_MISSING')) {
        await this.disableBiometricUnlock();
        await AsyncStorage.setItem(WalletManager.DEK_ROTATE_KEY, '1').catch(() => {});
      }
      return fallback;
    }
    try {
      await openPayload(withBio.vault, await aesKey(dek));
      return this._session === s ? { ok: true } : fallback;
    } catch (_) {
      return fallback;
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Biometric unlock: { ok, token } | { ok: false, cancelled } | { ok: false, invalidated } (a new
   * fingerprint or face was enrolled: biometric unlock is off and the password takes over).
   */
  async unlockWithBiometrics() {
    if (await this.usesDeviceAuth()) {
      // The secret opened the vault: an older build's item moves to the app's own group (the old item goes only
      // after that), a rotation that stopped halfway is settled, and a rotation that is due runs (_openChecked,
      // _finishUnlock). The secret stays in this module.
      const { r, opened, secret } = await this._openChecked(WalletManager.deviceAuthCredential(tr('bio_prompt_unlock')));
      if (r.cancelled) return { ok: false, cancelled: true };
      if (r.gone) return { ok: false, gone: true };
      if (r.failed) return r.notNow ? { ok: false, failed: true, notNow: true } : { ok: false, failed: true };
      if (!r.ok) return r;
      return this._finishUnlock(opened, secret, true);
    }
    const withBio = (await this._vaultCandidates()).find((c) => isVaultV4(c.vault) && c.vault.bio);
    if (withBio) {
      let dek;
      try {
        dek = await unwrapWithBio(withBio.vault, biometricSealer({ title: tr('bio_prompt_unlock'), cancel: tr('bio_use_password') }));
      } catch (e) {
        if (e && (e.code === 'KEY_INVALIDATED' || e.code === 'KEY_MISSING')) {
          await this.disableBiometricUnlock();
          // A fingerprint or face was enrolled: the next password unlock gives the vault a fresh data key.
          await AsyncStorage.setItem(WalletManager.DEK_ROTATE_KEY, '1').catch(() => {});
          return { ok: false, invalidated: true };
        }
        return { ok: false, cancelled: true };
      }
      try {
        const dekKey = await aesKey(dek);
        await openPayload(withBio.vault, dekKey); // proves the key before a session is opened on it
        await this._upgradeDeviceSeal(withBio.vault); // MVA-R4-01: no password needed for that
        // A move to the screen lock that stopped before its flag went up left the typed password in the staging item:
        // it goes here too, not only at a password unlock (MA-4).
        await this._dropStrayStaging();
        return { ok: true, token: this._openSession(dekKey, withBio.vault.id) };
      } finally {
        dek.fill(0);
      }
    }
    // No biometric wrap: biometric unlock is off. An older build's password item is never read here; it is
    // deleted at launch (purgeLegacyBiometric) and, should it still exist, deleted now.
    await this.purgeLegacyBiometric();
    return { ok: false, cancelled: true };
  }

  // ---------------------------------------------------------------------------
  // Legacy vault crypto (versions 1–3), kept only to read and migrate old vaults and code records.
  // ---------------------------------------------------------------------------

  // PBKDF2-SHA256 → AES-256-GCM key through crypto.subtle (react-native-quick-crypto: native, off the JS thread).
  async _deriveKeyNative(password, saltHex, iterations = WalletManager.VAULT_ITERATIONS_V3) {
    const passwordBytes = Buffer.from(password == null ? '' : String(password), 'utf8');
    const salt = this._hexToBytes(saltHex);
    const keyMaterial = await crypto.subtle.importKey(
      'raw', passwordBytes, 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  _bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  _hexToBytes(hex) {
    // Reject malformed hex up front — a bad char/odd length would otherwise
    // make parseInt return NaN, which coerces to 0 and silently corrupts crypto input.
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error('Invalid hex input');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  // Version 1 vaults (written by CryptoJS): PBKDF2-SHA256 with 10,000 iterations, then AES-256-CBC with
  // PKCS#7 padding over base64 ciphertext. Read only to migrate them on first unlock.
  async _decryptCBC(vaultData, password) {
    const material = await crypto.subtle.importKey(
      'raw', Buffer.from(password == null ? '' : String(password), 'utf8'), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: this._hexToBytes(vaultData.salt), iterations: 10000, hash: 'SHA-256' },
      material, { name: 'AES-CBC', length: 256 }, false, ['decrypt']);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: this._hexToBytes(vaultData.iv) }, key, Buffer.from(String(vaultData.encrypted || ''), 'base64'));
    } catch (_) {
      throw new Error('Wrong password or corrupted wallet'); // a wrong key almost always fails the padding
    }
    const str = Buffer.from(plain).toString('utf8');
    if (!str) throw new Error('Wrong password or corrupted wallet');
    return str;
  }

  // Everything on the device that belongs to one wallet (its address, node, tokens). Device settings — language,
  // auto-lock, discovered nodes — are not in it, and transaction history is kept per wallet (services/HistoryCache).
  static WALLET_SCOPED_KEYS = [
    'qnet_address', 'qnet_address_scheme',
    'qnet_last_activated_node', 'qnet_cached_server_status', 'qnet_node_link_pending',
    'qnet_custom_tokens', 'qnet_hidden_tokens', 'qnet_node_rewards', 'qnet_rate_limit',
    'qnet_last_sent_fcm_token', 'qnet_last_token_refresh_ts', 'qnet_needs_token_refresh',
    'qnet_pending_txs', 'qnet_qc_anchors', 'qnet_balance_cache',
    'qnet_dapp_sites', 'qnet_browser_history', 'qnet_nonce_hwm',
    'qnet_dek_rotate', 'qnet_sent_recipients', 'qnet_shown_tokens',
  ];
  static WALLET_SCOPED_PREFIXES = ['qnet_identity_pk_'];

  // Forget the wallet that was on this device. Work still in flight for it (a sync, a registration)
  // sees the generation change and writes nothing. The light-node identity is torn down by the caller
  // (PushService.teardownLightNode), the vault itself by the caller or by storeWallet overwriting it. The in-app
  // browser's cookies, site storage and caches go too (L-6), best effort and not waited for.
  async wipeWalletScope() {
    this._walletGen++;
    this.closeSession();
    clearBrowserData().catch(() => {});
    await this._limiter.reset();
    const all = await AsyncStorage.getAllKeys();
    const doomed = all.filter(k => WalletManager.WALLET_SCOPED_KEYS.includes(k) ||
      WalletManager.WALLET_SCOPED_PREFIXES.some(p => k.startsWith(p)));
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
  }

  /**
   * Delete wallet: every AsyncStorage key except the allow-list, every Keychain item the app wrote (vault
   * secret, ping keys, lockout, the device key record), the Keystore keys (the node's device key too), the
   * session, a copied recovery phrase still on the clipboard, and what the in-app browser left on the device (its
   * cookies, site storage and caches, L-6: best effort, never waited for, so a web view never holds up the erase). The
   * caller has already checked a fresh authentication and torn down the light node.
   */
  async eraseAllData() {
    this._walletGen++;
    this.closeSession();
    clearBrowserData().catch(() => {});
    await clearSecretCopy();
    await this._limiter.reset();
    const all = await AsyncStorage.getAllKeys();
    const doomed = all.filter((k) => !WalletManager.ERASE_ALLOW_LIST.includes(k));
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
    await forgetNodeDeviceKeys().catch(() => {}); // before the Keychain wipe: its record names the key to delete
    await this._wipeKeychain();
    await deleteDeviceKeys();
  }

  async _wipeKeychain() {
    let services = [];
    // Listing never prompts: an item behind Face ID is skipped here and named explicitly below.
    try { services = (await Keychain.getAllGenericPasswordServices({ skipUIAuth: true })) || []; } catch (_) { services = []; }
    const all = new Set([...services, WalletManager.KEYCHAIN_SERVICE, WalletManager.DEVICE_AUTH_SERVICE,
      WalletManager.DEVICE_AUTH_NEXT_SERVICE, LIMITER_SERVICE]);
    for (const service of all) {
      try { await Keychain.resetGenericPassword({ service }); } catch (_) { /* keep going */ }
    }
  }

  /**
   * First launch of this installation: iOS keeps Keychain items across an uninstall while the vault goes
   * with the app, so anything left from before is wiped. A device that already holds a vault only gets
   * the marker (an update, not a reinstall). The wipe removes the only secret that opens a stored vault, so it
   * runs on a definite "no vault stored" alone: storage that cannot be read, or a copy that does not parse, wipes
   * nothing and writes no marker, and the next launch decides again (MVA-R3-01).
   */
  async prepareInstall() {
    try {
      if (await AsyncStorage.getItem(WalletManager.INSTALL_MARKER)) return;
      const state = await this.vaultState();
      if (state !== 'none' && state !== 'ok') return;
      if (state === 'none') {
        await this._wipeKeychain();
        await deleteDeviceKeys();
      }
      await AsyncStorage.setItem(WalletManager.INSTALL_MARKER, '1');
    } catch (_) { /* the next launch tries again */ }
  }

  /**
   * A new password, and with it a new data key (MVA-R2-06): the payload, the sealed recovery phrase and every
   * sealed record are sealed again under a fresh key, so a data key captured before the change opens nothing
   * written after it. The biometric wrap held the old key, so biometric unlock is off afterwards
   * ({ biometricOff: true }). The open session keeps working. Counted by the lockout.
   */
  async changePassword(currentPassword, newPassword) {
    await WalletManager._assertNewPassword(newPassword);
    let opened = null;
    const r = await this._checked(currentPassword, async () => { opened = await this._openVault(currentPassword); });
    if (!r.ok) {
      const e = new Error(r.locked ? 'Too many wrong passwords' : 'Current password is incorrect');
      e.lockout = r;
      throw e;
    }
    if (!opened.dek) opened = await this._openVault(currentPassword); // migrated just now: open the new vault
    const hadBio = !!opened.vault.bio;
    try {
      await this._rotateDek(opened, newPassword);
    } finally {
      opened.dek.fill(0);
    }
    await AsyncStorage.removeItem(WalletManager.DEK_ROTATE_KEY).catch(() => {});
    if (hadBio) await deleteBiometricKey();
    return { biometricOff: hadBio };
  }

  // Every record sealed under the vault's data key outside the vault itself: AsyncStorage key and AAD purpose.
  static DEK_ROTATE_KEY = 'qnet_dek_rotate';
  static SEALED_RECORDS = [
    { key: 'qnet_qc_anchors', purpose: 'qc-anchors' },
    { key: 'qnet_dapp_sites', purpose: 'dapp-sites' },
    { key: 'qnet_sent_recipients', purpose: 'sent-recipients' },
    { key: 'qnet_balance_cache', purpose: 'balance-cache' },
  ];

  /**
   * A fresh data key for the opened vault, sealed for `password`: the payload, the recovery phrase and every
   * sealed record are sealed again under it and written with the vault in one multiSet, with the `extra` [key, value]
   * pairs (a flag that must change with this vault and never apart from it). The biometric wrap of the old key is
   * dropped. An open session on this vault moves to the new key. Returns { vault, dekKey }.
   */
  async _rotateDek(opened, password, extra = []) {
    const { vault, dekKey, payload } = opened;
    const dek = randomBytes(DEK_BYTES);
    try {
      const nextKey = await aesKey(dek);
      // A vault on the current device key keeps it: the key that just opened it is the one proven to work, and no
      // Keystore probe runs while the stored vault depends on that key (MVA-R5-01). An unsealed vault, or one on the
      // legacy key, moves to the current key when one can be made (MVA-R4-01), else keeps what it has.
      const own = this._sealerFor(vault);
      const hw = isCurrentDeviceSealer(vault.hw) && own ? own : ((await deviceSealer()) || own);
      let next = await rewrapPassword(withoutBioWrap(vault), dek, password, { hw });
      next = await sealPayload(next, nextKey, payload);
      delete next.seed;
      // A phrase record that no longer opens is already lost; it is not carried over.
      const phrase = await openMnemonic(vault, dekKey).catch(() => null);
      if (phrase) next = await withMnemonic(next, nextKey, phrase);
      const records = await this._resealRecords(vault.id, dekKey, nextKey);
      // A new generation: a write that stops between the two copies leaves the one under the old password behind.
      next.gen = await this._nextGen(vault);
      const text = JSON.stringify(next);
      await this._writeRotation([[WalletManager.VAULT_KEY, text], [WalletManager.VAULT_BACKUP_KEY, text], ...records, ...extra], text);
      if (this._session && this._session.vaultId === vault.id) {
        // A new session object: work in flight that sealed under the old key sees the change and writes nothing.
        this._session = { ...this._session, dekKey: nextKey };
      }
      return { vault: next, dekKey: nextKey };
    } finally {
      dek.fill(0);
    }
  }

  // A rotation's one write. iOS writes a multiSet key by key and reports a failure only after the rest (MA-R3-01), so a
  // write that failed may still have stored a copy of the new vault, which its generation makes the one that opens: what
  // is stored decides, not the error. A new copy stored: the rest is written again, and the rotation stands (a record
  // still not written is one that no longer opens). None stored: the error, nothing changed. Storage that cannot be
  // read back: the error, marked `unsettled` (the stored copies tell at the next read which vault is the wallet).
  async _writeRotation(pairs, text) {
    try {
      await AsyncStorage.multiSet(pairs);
      return;
    } catch (e) {
      let stored = null;
      for (let i = 0; i < 3 && stored === null; i++) {
        stored = await this._vaultCandidates({ all: true }).catch(() => null);
      }
      if (stored === null) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { unsettled: true });
      if (!stored.some((c) => c.raw === text)) throw e;
      await AsyncStorage.multiSet(pairs).catch(() => {
        logger.warn('[WARN][VAULT] new vault stored, the rest of its write failed');
      });
    }
  }

  // [key, text] pairs: each record of this vault opened with `fromKey` and sealed again with `toKey`. A record
  // that does not open is left as it is (nothing could read it before either).
  async _resealRecords(vaultId, fromKey, toKey) {
    const out = [];
    const read = async (key) => {
      try { return JSON.parse((await AsyncStorage.getItem(key)) || 'null'); } catch (_) { return null; }
    };
    const reseal = async (rec, purpose) => {
      if (!rec || typeof rec !== 'object' || rec.vault !== vaultId) return null;
      try {
        return await sealRecord(toKey, vaultId, await openRecord(fromKey, rec, purpose), purpose);
      } catch (_) {
        return null;
      }
    };
    for (const { key, purpose } of WalletManager.SEALED_RECORDS) {
      const sealed = await reseal(await read(key), purpose);
      if (sealed) out.push([key, JSON.stringify(sealed)]);
    }
    return out;
  }

  /**
   * Why `password` may not seal a new vault: 'PASSWORD_TOO_SHORT' or null. The rule of both wallets
   * (crypto/PasswordStrength): its length only.
   */
  static async newPasswordProblem(password) {
    return passwordTooShort(password) ? 'PASSWORD_TOO_SHORT' : null;
  }

  static async _assertNewPassword(password) {
    const code = await WalletManager.newPasswordProblem(password);
    if (!code) return;
    throw Object.assign(new Error('This password is too short'), { code, params: { min: WalletManager.MIN_PASSWORD_LENGTH } });
  }

  /**
   * Whether a new wallet may be written: no vault copy is stored, and storage could be read to tell. A new wallet
   * never takes the place of a stored one; replacing it goes through Delete wallet or Erase and restore
   * (eraseAllData), which remove the vault first (MVA-R2-03).
   */
  async canStoreNewWallet() {
    try {
      const pairs = await AsyncStorage.multiGet([WalletManager.VAULT_KEY, WalletManager.VAULT_BACKUP_KEY]);
      return !pairs.some(([, v]) => !!v);
    } catch (_) {
      return false;
    }
  }

  /**
   * Seals a new or imported wallet under a generated vault secret that goes straight behind the screen lock
   * (DeviceAuthStore), and opens the session on it. The secret never leaves this module: the screen holds no copy of
   * it at any step (MVA-R3-03). Refused with WALLET_EXISTS while a vault is stored (or storage cannot tell), and with
   * DEVICE_LOCK when the device refuses the secret (no screen lock now), before any vault is written.
   * DEVICE_LOCK_CANCELLED (the prompt was refused) and DEVICE_LOCK_RETRY (the prompt failed this time) keep nothing:
   * the same step asks again.
   */
  async storeWalletWithDeviceAuth(walletData, prompt = tr('auth_device_unlock')) {
    if (!(await this.canStoreNewWallet())) {
      throw Object.assign(new Error('A wallet is already stored on this device'), { code: 'WALLET_EXISTS' });
    }
    const secret = this.generateVaultPassword();
    const kept = await this._protectNewSecret(secret, prompt);
    if (kept === 'cancelled') {
      throw Object.assign(new Error('The screen lock prompt was refused'), { code: 'DEVICE_LOCK_CANCELLED' });
    }
    if (kept === 'retry') {
      throw Object.assign(new Error('The screen lock could not be used just now'), { code: 'DEVICE_LOCK_RETRY' });
    }
    if (kept !== 'ok') throw Object.assign(new Error('The device refused the vault secret'), { code: 'DEVICE_LOCK' });
    return this.storeWallet(walletData, secret, { deviceAuth: true });
  }

  /**
   * Seals a new or imported wallet in a new vault and opens the session on it: returns the session token.
   * Refused while a vault is stored (WALLET_EXISTS) and for a password that is too short.
   * Data a previous wallet left without a vault is cleared first. `deviceAuth`: the password is a generated secret
   * kept behind the screen lock (storeWalletWithDeviceAuth); the flag that says so is written before the vault.
   */
  async storeWallet(walletData, password, { deviceAuth = false } = {}) {
    await WalletManager._assertNewPassword(password);
    if (!(await this.canStoreNewWallet())) {
      throw Object.assign(new Error('A wallet is already stored on this device'), { code: 'WALLET_EXISTS' });
    }
    // A different wallet takes this device: nothing the previous one left may carry over. The same
    // wallet re-saved keeps everything.
    const prevQnet = await AsyncStorage.getItem('qnet_address');
    const prevSol = await AsyncStorage.getItem('qnet_wallet_address');
    if ((prevQnet && walletData.qnetAddress && prevQnet !== walletData.qnetAddress) ||
        (prevSol && walletData.address && prevSol !== walletData.address)) {
      await this.wipeWalletScope();
    }
    // The first session after an import never decrypts again, so seed the identity cache here too —
    // after the wipe, which clears every identity key.
    await this.cacheLightIdentityPk(walletData);

    const { vault, dekKey } = await this._createWalletVault(walletData, password);
    if (deviceAuth) {
      await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_FLAG, '1');
    } else {
      await AsyncStorage.removeItem(WalletManager.DEVICE_AUTH_FLAG);
      // A password wallet holds no screen-lock secret: one a refused attempt left goes.
      for (const s of [WalletManager.DEVICE_AUTH_SERVICE, WalletManager.DEVICE_AUTH_NEXT_SERVICE]) {
        await removeDeviceAuth(s).catch(() => {});
      }
    }
    await this._writeVault(vault);
    // Sealed: the caller's object no longer carries the phrase (kept until here so a failed save can retry).
    delete walletData._tempMnemonic;
    delete walletData.mnemonic;
    await AsyncStorage.setItem('qnet_wallet_address', walletData.address);
    // getCurrentWallet (the no-password path) reads the QNet address from here, so it must follow the
    // wallet just saved rather than wait for the next unlock.
    if (walletData.qnetAddress) {
      await AsyncStorage.setItem('qnet_address', walletData.qnetAddress);
      await AsyncStorage.setItem('qnet_address_scheme', 'fips204');
    }
    return this._openSession(dekKey, vault.id);
  }

  // ── Nodes: which node gets which request (services/NodePool) ─────────────────────────────────────────
  // Everything goes to the five genesis names, except reads the wallet checks against a committee-certified
  // checkpoint: those may also go to an endpoint at least two genesis nodes list. A node list is never
  // taken from one answer, and no answer can remove a genesis name.

  static discovered = [];          // agreed third-party endpoints: [{ url, confirmedAt }]
  static discoveredLoaded = false;
  static lastDiscoveryTime = 0;
  static nodeHealth = {};          // baseUrl -> { ewmaMs, fails, lastFailAt } — client-side latency/failure
  static droppedForSession = new Set(); // read-pool endpoints that served an oversized answer (MOBNET-R2-06)
  static pkBound = {};             // address -> true once a chain read showed its ML-DSA key committed
  // Agreement reads ask this many genesis names first, the rest only without a verdict (_fromGenesis, M14).
  static GENESIS_AGREEMENT_FIRST = 3;
  // An agreed balance read is shared for this long (agreedGenesisBalance).
  static GENESIS_READ_REUSE_MS = 10_000;
  static genesisBalanceReads = new Map(); // address -> { promise, pending, at }

  /** The endpoints kept from earlier rounds. Older builds' pool (which one node's answer could replace) is dropped. */
  async loadNodesFromCache() {
    WalletManager.discovered = await loadDiscovered();
    WalletManager.discoveredLoaded = true;
  }

  /**
   * One discovery round: the validator list from up to three genesis nodes. An endpoint joins the read pool
   * only when at least two of them list it; the pool is never asked about itself.
   */
  async refreshNodeDiscovery() {
    if (Date.now() - WalletManager.lastDiscoveryTime < 30000) return;
    WalletManager.lastDiscoveryTime = Date.now();
    if (!WalletManager.discoveredLoaded) await this.loadNodesFromCache();
    const answers = (await Promise.all(shuffledGenesisNodes().slice(0, 3).map((base) =>
      this._getJson(base, '/api/v1/validators/proof', 5000).catch(() => null)))).filter(Boolean);
    if (answers.length < MIN_GENESIS_AGREEMENT) {
      logger.warn('[DISCOVERY] too few genesis answers:', answers.length);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    WalletManager.discovered = mergeEndpoints(WalletManager.discovered, agreedEndpoints(answers, now), now);
    await saveDiscovered(WalletManager.discovered);
  }

  _recordNode(base, ok, ms) {
    const h = WalletManager.nodeHealth[base] || { ewmaMs: 300, fails: 0, lastFailAt: 0 };
    if (ok) { h.ewmaMs = h.ewmaMs * 0.7 + ms * 0.3; h.fails = 0; }
    else { h.fails = Math.min(h.fails + 1, 10); h.lastFailAt = Date.now(); }
    WalletManager.nodeHealth[base] = h;
  }

  _recentlyFailed(base) {
    const h = WalletManager.nodeHealth[base];
    return !!h && h.fails >= 3 && (Date.now() - h.lastFailAt) < 30000;
  }

  // Up to `count` of `urls` in random order, recently failing ones last.
  _pickNodes(urls, count) {
    const a = urls.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return [...a.filter((u) => !this._recentlyFailed(u)), ...a.filter((u) => this._recentlyFailed(u))].slice(0, count);
  }

  /** Genesis names only: every write, everything that carries a device identifier, every read nothing proves. */
  getTrustedNodes(count = 2) {
    return this._pickNodes(GENESIS_NODES, count);
  }

  /** One genesis name, for a single call. */
  trustedNodeUrl() {
    return this.getTrustedNodes(1)[0];
  }

  /** Genesis names plus agreed endpoints: ONLY for reads verified against a certified checkpoint. */
  getReadNodes(count = 2) {
    if (Date.now() - WalletManager.lastDiscoveryTime > DISCOVERY_INTERVAL_MS) this.refreshNodeDiscovery().catch(() => {});
    return this._pickNodes(readPoolUrls(WalletManager.discovered).filter((u) => !WalletManager.droppedForSession.has(u)), count);
  }

  async _getJson(base, path, timeoutMs = 5000) {
    const ctl = new AbortController();
    const guard = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal });
      this._recordNode(base, true, Date.now() - t0);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (!/^HTTP \d/.test((e && e.message) || '')) this._recordNode(base, false, Date.now() - t0);
      throw e;
    } finally {
      clearTimeout(guard);
    }
  }

  // Hedged request: fire the primary; if silent for hedgeMs, race a second node in parallel; first
  // success wins and aborts the rest; a failing node hands off to the next at once. Each attempt is
  // capped by timeoutMs. A CLIENT-signed, content-addressed POST is safe to hedge (the mempool dedups
  // the double-submit). A server-BUILDS-the-TX POST is NOT (two nodes mint two distinct hashes for one
  // logical op) — pass nodes:getTrustedNodes(1) for those (e.g. /api/v1/node-registration/submit).
  // Without `nodes` it asks genesis nodes only.
  // `settleOn(res)`: settle only on an answer it accepts (a transaction submit: the node took it). Any other answer
  // does not abort the other node's request: every launched request is let finish, and the result is the first
  // answer with `answers` (all of them) and `unanswered` (requests that ended with no answer: that node may hold the
  // transaction all the same, so a refusal next to one is no final refusal: MOBNET-R4-02).
  async _hedged(path, {
    method = 'GET', body = null, timeoutMs = 4000, hedgeMs = 700, nodes = null, raw = false, settleOn = null, maxBytes = null,
  } = {}) {
    // A submit (a claim, a send) reaches every genesis name in turn while connections fail: two unreachable ones never
    // fail it. Only a failure starts the next one; an answer that does not settle still hedges to two at most.
    const bases = nodes || this.getTrustedNodes(method === 'GET' ? 2 : 5);
    if (method === 'GET' && !settleOn) return this._hedgedRead(path, { timeoutMs, hedgeMs, bases, raw, maxBytes });
    const ctrls = [];
    let settled = false, launched = 0, pending = 0, lastErr = null;
    const answers = [];
    let unanswered = 0;
    const run = (base) => new Promise((resolve, reject) => {
      const c = new AbortController(); ctrls.push(c);
      const t0 = Date.now();
      const guard = setTimeout(() => c.abort(), timeoutMs);
      fetch(`${base}${path}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: c.signal,
      }).then(async (r) => {
        clearTimeout(guard);
        const data = raw ? (await r.text().catch(() => '')) : (await r.json().catch(() => ({})));
        this._recordNode(base, true, Date.now() - t0);
        resolve({ ok: r.ok, status: r.status, data, base });
      }).catch((e) => {
        clearTimeout(guard); this._recordNode(base, false, Date.now() - t0); reject(e);
      });
    });
    return new Promise((resolve, reject) => {
      // Every launched request ended without a settling answer (settleOn only).
      const finish = () => {
        settled = true;
        if (answers.length > 0) resolve({ ...answers[0], answers: answers.slice(), unanswered });
        else reject(lastErr || new Error('all nodes failed'));
      };
      const launch = (i) => {
        if (settled || i >= bases.length) return;
        launched++; pending++;
        run(bases[i]).then((res) => {
          pending--;
          if (settled) return;
          if (!settleOn || settleOn(res)) {
            settled = true; ctrls.forEach(c => { try { c.abort(); } catch (_) {} });
            resolve(settleOn ? { ...res, answers: [...answers, res], unanswered } : res);
            return;
          }
          answers.push(res);
          if (launched < Math.min(2, bases.length)) launch(launched); // an answer that does not settle: the hedge now
          else if (pending === 0) finish();
        }).catch((e) => {
          pending--; lastErr = e;
          if (settled) return;
          if (settleOn) unanswered++;
          if (launched < bases.length) launch(launched);            // failed → next immediately
          else if (pending === 0) {
            if (settleOn) finish();
            else reject(lastErr || new Error('all nodes failed'));
          }
        });
      };
      launch(0);
      if (bases.length > 1) setTimeout(() => { if (!settled && launched < 2) launch(1); }, hedgeMs);
    });
  }

  // A read through the hedged path (GET). An answer counts only when it is 2xx, its body could be read (as JSON) within
  // the attempt's time, and it is not a rate-limit answer (a node's limiter answers HTTP 200 with
  // {"error": "Rate limit exceeded"}). The attempt's timer runs until the body is read, so a body that stalls times out.
  // Anything else is that node's failure, and the next node is asked at once; the second also goes out when the first
  // is silent for hedgeMs. The first answer that counts wins and aborts the rest. Only once every node answered or
  // failed: the last answer that came, as { ok: false, status, data, base } (rateLimited for a rate-limit answer), else
  // the last error. `maxBytes`: a raw body longer than that is that node's failure. A node that answers 429 or 503 with
  // a wait (Retry-After, or the body's retry_after_seconds) is asked after the others until then (_proofOrder).
  _hedgedRead(path, { timeoutMs, hedgeMs, bases, raw, maxBytes = null }) {
    const ctrls = [];
    let settled = false;
    let launched = 0;
    let pending = 0;
    let lastErr = null;
    let lastAnswer = null;
    const run = async (base) => {
      const c = new AbortController();
      ctrls.push(c);
      const t0 = Date.now();
      let guard;
      const timedOut = new Promise((_, reject) => {
        guard = setTimeout(() => {
          try { c.abort(); } catch (_) { /* already over */ }
          reject(new Error('Timed out'));
        }, timeoutMs);
      });
      const answer = (async () => {
        const r = await fetch(`${base}${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: c.signal });
        let data = null;
        let parsed = null;
        try {
          if (raw) {
            data = await r.text();
            if (Number.isSafeInteger(maxBytes) && typeof data === 'string' && data.length > maxBytes) {
              return { ok: false, status: r.status, data: null, base, oversized: true };
            }
            parsed = JSON.parse(data);
          } else {
            data = await r.json();
            parsed = data;
          }
        } catch (_) {
          return { ok: false, status: r.status, data, base };
        }
        if (r.status === 429 || r.status === 503) WalletManager._noteRetryAfter(base, r, parsed);
        if (isRateLimitBody(parsed)) return { ok: false, status: r.status, data, base, rateLimited: true };
        return { ok: !!r.ok, status: r.status, data, base };
      })();
      try {
        const res = await Promise.race([answer, timedOut]);
        this._recordNode(base, res.ok, Date.now() - t0);
        return res;
      } catch (e) {
        if (!settled) this._recordNode(base, false, Date.now() - t0);
        throw e;
      } finally {
        clearTimeout(guard);
      }
    };
    return new Promise((resolve, reject) => {
      const next = () => {
        if (launched < bases.length) { launch(launched); return; }
        if (pending > 0) return;
        settled = true;
        if (lastAnswer) resolve(lastAnswer);
        else reject(lastErr || new Error('all nodes failed'));
      };
      const launch = (i) => {
        if (settled || i >= bases.length) return;
        launched += 1;
        pending += 1;
        run(bases[i]).then((res) => {
          pending -= 1;
          if (settled) return;
          if (res.ok) {
            settled = true;
            ctrls.forEach((c) => { try { c.abort(); } catch (_) { /* already over */ } });
            resolve(res);
            return;
          }
          lastAnswer = res;
          next();
        }, (e) => {
          pending -= 1;
          lastErr = e;
          if (!settled) next();
        });
      };
      if (bases.length === 0) { reject(new Error('all nodes failed')); return; }
      launch(0);
      if (bases.length > 1) setTimeout(() => { if (!settled && launched < 2) launch(1); }, hedgeMs);
    });
  }

  /**
   * Did the submit come back without a verdict? An aborted or broken request says nothing about the
   * transaction — the node may hold it and only the reply was lost — so this class of failure is
   * UNKNOWN, never failed. A verdict the node actually returned is not this.
   */
  static isUnansweredSubmit(err) {
    const s = `${(err && err.name) || ''} ${(err && err.message) || ''}`.toLowerCase();
    return /abort|timeout|timed out|network request failed|failed to fetch|all nodes failed|network error/.test(s);
  }

  /**
   * The outcome of a submit nobody settled, decided by the chain and keyed by (from, nonce). While the
   * account's nonce has not reached ours, the kept transaction is sent again, the same bytes
   * (rebroadcastPending). Once it has, the nonce is spent — but not necessarily by this transaction: one that
   * replaced it, or one this wallet's recovery phrase signed elsewhere (the browser extension), takes the same
   * nonce. So "landed" needs the applied transaction itself: the account's history row at (from, nonce) must be
   * this transaction (`kind`, recipient, amount). A different one there means it can no longer apply
   * (`replaced`); no row yet means the outcome is still unread, never a guess either way.
   *
   * The applied hash comes from that row rather than from the submit: a hedged submit puts one copy on each of
   * two nodes, each stamps its own timestamp, so the hash the wallet was handed is not necessarily the copy
   * that landed.
   */
  // A contract call or a deploy is "landed" only when the applied row is bound to its own content: a QRC-20
  // transfer by its decoded transfer event (contract, recipient, amount). A call the wallet cannot bind, or a
  // deploy, is reported as `unbound` (it went through, or something replaced it: see the history), never as
  // sent (MOBNET-R2-02).
  async resolveSubmitByNonce(address, nonce, {
    toAddress = null, amountNano = null, kind = 'transfer', method = null, recipient = null, amountBase = null,
  } = {}) {
    const res = await this._hedged(`/api/v1/account/${address}`, { timeoutMs: 4000, hedgeMs: 700 });
    if (!res || !res.ok || !res.data) return { landed: false, known: false };
    const accountNonce = Number(res.data.nonce) || 0;
    if (accountNonce < nonce) {
      // Nodes admit only the account's next nonce: an appended transaction goes out again once the one before it
      // has applied, and not before (MOBNET-R2-04).
      if (nonce === accountNonce + 1) await this.rebroadcastPending(address, nonce).catch(() => false);
      const kept = await pendingEntry(address, nonce).catch(() => null);
      // `sending`: the wallet still sends it again by itself (MOBNET-R3-01); false once it stopped for good.
      // `mayLandUntil`: until when a node may still hold it, so it can still go through (MOBNET-R4-02); null when the
      // wallet keeps no copy (stopped by the user, or replaced).
      const mayLandUntil = kept ? pendingView(kept).mayLandUntil : await stoppedUntil(address, nonce).catch(() => null);
      return {
        landed: false, known: true, held: !!(kept && kept.state === 'accepted'), sending: !!(kept && autoSendable(kept)),
        mayLandUntil,
      };
    }
    const row = await this._appliedRowAtNonce(address, nonce);
    // No node gave the history: nothing learned, as when the account went unread (a history row is never marked not
    // found on a read that failed, L-10).
    if (row === undefined) return { landed: false, known: false };
    if (!row) return { landed: false, known: true, spent: true };
    const txHash = typeof row.hash === 'string' ? row.hash : null;
    if (!WalletManager._rowIsTransaction(row, { kind, toAddress, amountNano })) return { landed: false, known: true, replaced: true };
    if (kind === 'transfer') return { landed: true, known: true, txHash };
    const bound = kind === 'call' && method === 'transfer' && recipient && amountBase
      ? await this._callIsTokenTransfer(address, txHash, { contract: toAddress, recipient, amountBase })
      : null;
    if (bound === true) return { landed: true, known: true, txHash };
    if (bound === false) return { landed: false, known: true, replaced: true };
    return { landed: false, known: true, unbound: true, txHash };
  }

  /**
   * Whether the applied call `txHash` moved `amountBase` of `contract` from `address` to `recipient`, read from
   * the decoded, success-gated transfer events of this wallet on the genesis nodes: true, false (it moved
   * something else), or null (no event of that call to read, or an amount JSON could not carry exactly).
   */
  async _callIsTokenTransfer(address, txHash, { contract, recipient, amountBase }) {
    if (!txHash) return null;
    const lc = (v) => String(v || '').toLowerCase();
    let rows;
    try {
      const res = await this._hedged(`/api/v1/account/${encodeURIComponent(address)}/token-transfers?limit=200`,
        { timeoutMs: 5000, hedgeMs: 800 });
      rows = res && res.ok && res.data && Array.isArray(res.data.transfers) ? res.data.transfers : null;
    } catch (_) {
      rows = null;
    }
    if (!rows) return null;
    const mine = rows.filter((r) => r && lc(r.tx_hash) === lc(txHash));
    if (mine.length === 0) return null;
    const amountIs = (v) => {
      if (typeof v === 'string') return /^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') === amountBase.replace(/^0+(?=\d)/, '') : null;
      if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) === amountBase.replace(/^0+(?=\d)/, '') : null;
      return null;
    };
    let unsure = false;
    for (const r of mine) {
      if (lc(r.contract) !== lc(contract) || lc(r.from) !== lc(address) || lc(r.to) !== lc(recipient)) continue;
      const same = amountIs(r.amount);
      if (same === true) return true;
      if (same === null) unsure = true;
    }
    return unsure ? null : false;
  }

  /** The applied transaction this wallet sent with `nonce`, from its history on the genesis nodes, or null. */
  // The applied transaction of this wallet at `nonce` in the genesis history: the row, null when the history read lists
  // none, undefined when no node gave the history.
  async _appliedRowAtNonce(address, nonce) {
    const me = String(address).toLowerCase();
    try {
      const res = await this._hedged(
        `/api/v1/transactions/history?address=${encodeURIComponent(address)}&direction=sent&per_page=100`,
        { timeoutMs: 5000, hedgeMs: 800 });
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.transactions)) return undefined;
      return res.data.transactions.find((t) => t && String(t.from).toLowerCase() === me && Number(t.nonce) === nonce) || null;
    } catch (_) {
      return undefined;
    }
  }

  /**
   * Where this wallet's transaction at (address, nonce) stands, for a site that holds its result (the in-app browser's
   * qnet_getTransactionStatus): 'pending' while the account has not reached the nonce and this wallet still sends the
   * transaction there (not stopped, not refused for a reason waiting cannot heal, and still able to land: the
   * extension's rule, CONTRACTS.md 4.9); 'in_block' once two genesis nodes list the same transaction of the account at
   * that nonce, with the block height two genesis nodes report alike (else null); 'unknown' otherwise, and when the one listed is not the one
   * this wallet signed there. It never says a contract call did what it was meant to: the chain records no outcome.
   */
  async transactionStatusAt(address, nonce) {
    const unknown = { status: 'unknown', blockHeight: null, txHash: null };
    if (!Number.isSafeInteger(nonce) || nonce < 1) return unknown;
    let confirmed;
    try {
      confirmed = await this._agreedGenesisNonce(address);
    } catch (_) {
      return unknown;
    }
    const kept = await pendingEntry(address, nonce).catch(() => null);
    if (confirmed < nonce) return kept && WalletManager.stillSent(kept) ? { ...unknown, status: 'pending' } : unknown;
    const mine = kept ? pendingView(kept) : (await recentSettled(address).catch(() => [])).find((r) => r && r.nonce === nonce);
    const row = await this._agreedRowAtNonce(address, nonce, mine || null);
    if (!row) return unknown;
    return { status: 'in_block', blockHeight: await this._agreedBlockHeight(row.hash), txHash: row.hash };
  }

  /**
   * The block height of the included transaction `hash` that at least MIN_GENESIS_AGREEMENT genesis nodes report alike
   * (the extension's rule, CONTRACTS.md 4.9), or null: one node, lagging or hostile, never names the height alone.
   */
  async _agreedBlockHeight(hash) {
    const path = `/api/v1/transaction/${encodeURIComponent(hash)}`;
    const heights = await Promise.all(this.getTrustedNodes(3).map((base) => this._getJson(base, path, 4000)
      .then((d) => (txLookupState(d, hash) === 'included' && Number.isSafeInteger(d.transaction.block_height)
        && d.transaction.block_height >= 0 ? d.transaction.block_height : null), () => null)));
    const count = new Map();
    for (const h of heights) if (h !== null) count.set(h, (count.get(h) || 0) + 1);
    const agreed = [...count].filter(([, n]) => n >= MIN_GENESIS_AGREEMENT).map(([h]) => h);
    return agreed.length === 1 ? agreed[0] : null;
  }

  // A send is decided only by a balance the committee certified (MB-R2-02, the owner's rule): a proof whose state root
  // a committee QC certifies through the light client. Never one node's unverified word, never what genesis nodes agree
  // on, never the figure on screen. The certified state lags the chain by minutes, so right after this wallet's own send
  // the next one's nonce is above the certified one: what this wallet's own transactions from the certified nonce on
  // take is counted against the certified figure (services/PendingTx spendableFrom), anything received since never is,
  // and a nonce in between that is none of this wallet's own transactions (spent from another device) refuses the send.
  // A proof read a moment ago is used again while it is at most SEND_PROOF_MAX_AGE_MS old; otherwise one verified read,
  // rooted at the checkpoints this device already certified, with SEND_CHECK_DEADLINE_MS for all of it (a long lineage
  // walk is never waited for).
  static SEND_PROOF_MAX_AGE_MS = 30_000;
  static SEND_CHECK_DEADLINE_MS = 6000;
  static SEND_PROOFS_MAX = 32;
  static sendProofs = new Map(); // 'qnc|address' | 'token|contract|holder' -> { figure, stateRoot, index, at }
  static sendReads = new Map();  // the same keys -> the verified read in flight

  static _keepSendProof(key, figure, stateRoot, index = null) {
    WalletManager.sendProofs.delete(key);
    WalletManager.sendProofs.set(key, {
      figure, stateRoot: String(stateRoot || ''), index: Number.isSafeInteger(index) ? index : null, at: Date.now(),
    });
    while (WalletManager.sendProofs.size > WalletManager.SEND_PROOFS_MAX) {
      WalletManager.sendProofs.delete(WalletManager.sendProofs.keys().next().value);
    }
  }

  static _keptSendProof(key) {
    const e = WalletManager.sendProofs.get(key);
    return e && Date.now() - e.at <= WalletManager.SEND_PROOF_MAX_AGE_MS ? e : null;
  }

  // An account nonce as a number, or null.
  static _nonceOf(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
    return typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null;
  }

  // The account nonce a send check counts this wallet's transactions up to: `nonce` (a value, its promise or a function
  // reading it; undefined: the one genesis nodes agree on), never below the highest this device confirmed (so a later
  // read never leaves out a transaction an earlier plan counted as settled). A read that fails gives that highest one
  // (every own transaction above the certified nonce is then counted as unsettled); null only for `nonce` null
  // (another account's balance, where nothing of this wallet counts).
  async _sendAccountNonce(address, nonce) {
    if (nonce === null) return null;
    const given = await Promise.resolve()
      .then(() => (nonce === undefined ? this._agreedGenesisNonce(address) : typeof nonce === 'function' ? nonce() : nonce))
      .then(WalletManager._nonceOf, () => null);
    return Math.max(given === null ? 0 : given, await this._nonceHighWater(address));
  }

  // A certified base for a send check. `kept()`: { nonce, figure, ... } of a proof read a moment ago, or null.
  // `fresh(progress)`: one verified read as { figure, nonce, ... }, or null; `progress.answered` is set once a node
  // answered. A kept proof at least as new as `accountNonce` is used at once; otherwise a fresh one is read (a newer
  // certified state may already hold the spends the account nonce shows) and the kept one stands in when none comes in
  // time. The base, or { error: 'unanswered' (no node answered) | 'unconfirmed' (answers came, none certified in time) }.
  async _sendBase(key, kept, fresh, accountNonce) {
    const k = kept();
    if (k && k.nonce !== null && accountNonce !== null && k.nonce >= accountNonce) return { ...k, cached: true };
    let read = WalletManager.sendReads.get(key);
    if (!read) {
      const progress = { answered: false };
      const none = () => ({ error: progress.answered ? 'unconfirmed' : 'unanswered' });
      let timer;
      read = Promise.race([
        Promise.resolve().then(() => fresh(progress)).then((r) => r || none(), none),
        new Promise((resolve) => { timer = setTimeout(() => resolve(none()), WalletManager.SEND_CHECK_DEADLINE_MS); }),
      ]).finally(() => {
        clearTimeout(timer);
        if (WalletManager.sendReads.get(key) === read) WalletManager.sendReads.delete(key);
      });
      WalletManager.sendReads.set(key, read);
    }
    const r = await read;
    if (r && r.figure) return r;
    return k ? { ...k, cached: true } : r;
  }

  // The holder's certified QNC base: { base: { figure, nonce, stateRoot, index, cached }, accountNonce } or { error }.
  async _certifiedQncBase(address, nonce) {
    const key = `qnc|${address}`;
    const accountNonce = await this._sendAccountNonce(address, nonce);
    const kept = () => {
      const e = WalletManager._keptSendProof(key);
      return e ? { nonce: WalletManager._nonceOf(e.figure.nonce), figure: e.figure, stateRoot: e.stateRoot, index: e.index } : null;
    };
    const fresh = async (progress) => {
      const r = await this.getQNCBalanceWithProof(address, true, { onAnswer: () => { progress.answered = true; } });
      if (r && (r.ok || r.reason === 'unconfirmed')) progress.answered = true;
      if (!r || !r.ok || !r.verified || WalletManager._nonceOf(String(r.nonce)) === null) return null;
      const index = Number.isSafeInteger(r.index) ? r.index : null;
      const figure = { ok: true, verified: true, balanceNano: r.balanceNano, nonce: String(r.nonce), balance: r.balance, index };
      return { figure, nonce: WalletManager._nonceOf(String(r.nonce)), stateRoot: String(r.stateRoot || ''), index };
    };
    const base = await this._sendBase(key, kept, fresh, accountNonce);
    return base.figure ? { base, accountNonce } : { error: base.error };
  }

  /**
   * The QNC balance a send is checked against (the Send form, the in-app browser's sheet, the nonce a send signs at),
   * from a committee-certified proof (see _sendBase): { ok: true, verified: true, balanceNano (the certified figure
   * less what this wallet's transactions settled since its checkpoint took), certifiedNano, nonce (the account nonce
   * in the certified state), accountNonce (the one counted up to), pending ([{ nonce, amount }]: what this wallet's
   * unsettled transactions may still take, nano), balance, index, cached }, or { ok: false, verified: false, error }:
   * 'unanswered' (the network did not answer), 'unconfirmed' (not certified in time, or what one of this wallet's
   * transactions takes is not known) or 'foreign' (a transaction from another device is not confirmed yet).
   * `nonce`: the account nonce the chain confirms (a value or its promise; null: unknown, nothing of this wallet is
   * counted); without it the one genesis nodes agree on.
   */
  async certifiedQncForSend(address, { nonce } = {}) {
    const refused = (error, extra = {}) => ({ ok: false, verified: false, balanceNano: null, nonce: null, error, ...extra });
    if (!address || typeof address !== 'string') return refused('Invalid address');
    const got = await this._certifiedQncBase(address, nonce);
    if (!got.base) return refused(got.error);
    const { base, accountNonce } = got;
    const figure = base.figure;
    const out = (balanceNano, pending, through) => ({
      ok: true, verified: true, balanceNano, certifiedNano: figure.balanceNano, nonce: figure.nonce, balance: Number(balanceNano) / 1e9,
      index: Number.isSafeInteger(base.index) ? base.index : null, accountNonce: through, pending, ...(base.cached ? { cached: true } : {}),
    });
    if (accountNonce === null) return out(figure.balanceNano, [], null);
    let spends;
    try { spends = await ownSpends(address); } catch (_) { return refused('unconfirmed'); }
    const certifiedNonce = WalletManager._nonceOf(figure.nonce);
    const r = spendableFrom({ certified: figure.balanceNano, certifiedNonce, accountNonce, spends });
    if (!r.ok) return refused(r.reason, r.nonce !== undefined ? { foreignNonce: r.nonce } : {});
    return out(r.balance, r.pending, Math.max(accountNonce, certifiedNonce));
  }

  /**
   * A token balance a send may be decided by (the Send form, the in-app browser's token transfers, a recipient's
   * deposit), from a committee-certified proof: { ok: true, verified: true, balanceBase (the certified figure less the
   * tokens this wallet's transactions settled since its checkpoint moved), certifiedBase, pending ([{ nonce, amount }]:
   * the tokens its unsettled transactions may still move), balance, cached } or { ok: false, error } as for
   * certifiedQncForSend. The holder's account nonce in the certified state comes from its certified QNC proof at the
   * same macroblock (the same state root, for a node from before certified proofs). `nonce` as for
   * certifiedQncForSend; null for another account (a recipient): its certified figure as it is.
   */
  async checkedTokenBalance(contract, holder, decimals = null, { nonce } = {}) {
    const refused = (error, extra = {}) => ({ ok: false, balance: null, balanceBase: null, verified: false, error, ...extra });
    if (!contract || !holder) return refused('unanswered');
    const key = `token|${contract}|${holder}`;
    const formatted = (base) => (decimals != null ? this._formatBaseUnits(base, decimals) : base);
    const readToken = (index) => async (progress) => {
      const r = await this.getTokenBalanceWithProof(contract, holder, null, true, { index });
      if (r && (r.ok || r.reason === 'unconfirmed')) progress.answered = true;
      if (!r || !r.ok || !r.verified || !/^\d+$/.test(String(r.balanceBase))) return null;
      return { figure: { balanceBase: String(r.balanceBase) }, nonce: null, stateRoot: String(r.stateRoot || ''), index: r.index };
    };
    if (nonce === null) {
      const got = await this._sendBase(key, () => null, readToken(null), null);
      if (!got.figure) return refused(got.error);
      return { ok: true, verified: true, balanceBase: got.figure.balanceBase, certifiedBase: got.figure.balanceBase, pending: [], cached: false, balance: formatted(got.figure.balanceBase) };
    }
    const qnc = await this._certifiedQncBase(holder, nonce);
    if (!qnc.base) return refused(qnc.error);
    const { base, accountNonce } = qnc;
    const index = Number.isSafeInteger(base.index) ? base.index : null;
    // Only a token proof of the same certified state as the QNC proof: the macroblock it names, else its root.
    const paired = (p) => !!p && (index !== null ? p.index === index : !!base.stateRoot && p.stateRoot === base.stateRoot);
    const kept = () => {
      const e = WalletManager._keptSendProof(key);
      return e && paired(e) ? { nonce: base.nonce, figure: e.figure, stateRoot: e.stateRoot, index: e.index } : null;
    };
    const fresh = async (progress) => {
      const r = await readToken(index)(progress);
      return r && paired(r) ? { ...r, nonce: base.nonce } : null;
    };
    const got = await this._sendBase(key, kept, fresh, base.nonce);
    if (!got.figure) return refused(got.error);
    // A read another check started may be of another state: it counts only paired with this one.
    if (!paired(got) || accountNonce === null) return refused('unconfirmed');
    let spends;
    try { spends = await ownSpends(holder); } catch (_) { return refused('unconfirmed'); }
    const r = spendableFrom({ certified: got.figure.balanceBase, certifiedNonce: base.nonce, accountNonce, spends, token: contract });
    if (!r.ok) return refused(r.reason, r.nonce !== undefined ? { foreignNonce: r.nonce } : {});
    return {
      ok: true, verified: true, balanceBase: r.balance, certifiedBase: got.figure.balanceBase, pending: r.pending,
      cached: !!got.cached, balance: formatted(r.balance),
    };
  }

  /**
   * Whether the wallet still sends the kept transaction `e` (MB-07): it sends it again by itself, or it is neither
   * stopped nor refused for good and some node may still hold it. A refused or stopped one is no longer 'pending'.
   */
  static stillSent(e, now = Date.now()) {
    if (!e || e.stopped) return false;
    if (autoSendable(e, now)) return true;
    const refusedForGood = e.state !== 'accepted' && !!e.refusal && !refusalHeals(e.refusal) && !e.refusalUncertain;
    return !refusedForGood && now < mayLandUntil(e);
  }

  /**
   * The sent transaction of `address` at `nonce` that at least two genesis nodes list alike (same hash), or null.
   * `mine` ({ kind, to, amountNano }) is what this wallet signed there when it still knows: a listed transaction that is
   * not it counts for nothing, and two listed ones it cannot tell apart answer null.
   */
  async _agreedRowAtNonce(address, nonce, mine = null) {
    const me = String(address).toLowerCase();
    const path = `/api/v1/transactions/history?address=${encodeURIComponent(address)}&direction=sent&per_page=100`;
    const lists = await Promise.all(this.getTrustedNodes(3).map((base) => this._getJson(base, path, 5000)
      .then((d) => (d && Array.isArray(d.transactions) ? d.transactions : null), () => null)));
    const seen = new Map(); // hash → { row, n }: in how many nodes' lists
    for (const rows of lists) {
      const atNonce = (rows || []).filter((x) => x && typeof x.hash === 'string'
        && String(x.from).toLowerCase() === me && Number(x.nonce) === nonce);
      for (const hash of new Set(atNonce.map((x) => x.hash))) {
        const entry = seen.get(hash) || { row: atNonce.find((x) => x.hash === hash), n: 0 };
        entry.n += 1;
        seen.set(hash, entry);
      }
    }
    const agreed = [...seen.values()].filter((e) => e.n >= MIN_GENESIS_AGREEMENT).map((e) => e.row)
      .filter((r) => !mine || WalletManager._rowIsTransaction(r, { kind: mine.kind, toAddress: mine.to, amountNano: mine.amountNano }));
    return agreed.length === 1 ? agreed[0] : null;
  }

  /** Whether an applied history row is the transaction described by (kind, recipient, nanoQNC amount). */
  static _rowIsTransaction(row, { kind = 'transfer', toAddress = null, amountNano = null }) {
    const to = toAddress ? String(toAddress).toLowerCase() : null;
    const rowTo = row.to ? String(row.to).toLowerCase() : null;
    if (kind === 'transfer') {
      return row.type === 'transfer' && !!to && rowTo === to && amountNano != null && Number(row.amount) === Number(amountNano);
    }
    // A call or a deploy of the same kind (and contract) is only a candidate: resolveSubmitByNonce binds it.
    if (kind === 'call') return row.type === 'contract_call' && !!to && rowTo === to;
    if (kind === 'deploy') return row.type === 'contract_deploy';
    return false;
  }

  /**
   * POST the signed claim. An unanswered submit is unknown, not failed: the claim may be in flight, and
   * because the chain marks an epoch paid, a later claim collects only what is still owed — so the
   * caller reports it as pending and nothing is ever paid twice. Only the submit is tagged this way; an
   * unanswered quote submitted nothing and stays an ordinary error.
   */
  async _submitClaim(body) {
    try {
      return await this._hedged('/api/v1/rewards/claim', { method: 'POST', timeoutMs: 8000, hedgeMs: 1200, body });
    } catch (e) {
      if (!WalletManager.isUnansweredSubmit(e)) throw e;
      const err = new Error('The network did not answer — this claim may still be on its way');
      err.unknown = { unknown: true, claim: true };
      throw err;
    }
  }

  /**
   * The unknown outcome of a submit nobody settled, in one shape for every path, so the UI reports and
   * resolves it the same way wherever it comes from. `refusal` is what a node answered, when one did: a
   * node that says no may still hold the signed bytes, so a refusal is unknown too. The transaction stays
   * kept (services/PendingTx), and the next send from this wallet takes its nonce.
   */
  _unknownOutcome(address, nonce, extra = {}) {
    logger.warn(`[SEND] outcome unknown: nonce=${nonce}`);
    return { unknown: true, nonce, from: address, ...extra };
  }

  /// True once a chain read showed this wallet's ML-DSA-65 pubkey committed on-chain, i.e. the 1952-byte key
  /// may be omitted from the wire (the node rehydrates it). A wrong true costs one resend with the key
  /// attached (`pk_unresolved`, same signature); doubt ⇒ false ⇒ the key rides along.
  static _pkElidable(address) {
    return WalletManager.pkBound[address] === true;
  }

  static NONCE_HWM_KEY = 'qnet_nonce_hwm';

  /**
   * The account nonce the chain confirms, from a QC-verified account proof and the value at least two genesis
   * nodes report. A certified state can be old (a proof from before a spend), so a verified value never
   * overrides a higher one the genesis nodes agree on; the higher of the two counts. Without an agreement, the
   * nonce never goes below the highest this device already confirmed for the address, so an old certified
   * state cannot make the wallet plan a nonce the chain has used. An agreement of the genesis nodes may set it
   * lower again (a chain rolled back), never one node's answer. Throws when neither is to be had.
   */
  async _confirmedAccountNonce(address) {
    // Both at once: the genesis answers also say whether the chain holds this wallet's key (pk elision). The proof is
    // the send check's certified base (_certifiedQncBase): one read a moment ago at least as new as the agreed nonce,
    // else one verified read within its deadline, never a long lineage walk. Only its nonce counts here.
    const agreement = this._agreedGenesisNonce(address).then((n) => ({ n }), (e) => ({ e }));
    const proof = await this._certifiedQncBase(address, agreement.then((a) => (a.e ? null : a.n))).catch(() => null);
    const agreed = await agreement;
    const proofNonce = proof && proof.base && Number.isSafeInteger(proof.base.nonce) ? proof.base.nonce : null;
    const agreedNonce = !agreed.e && Number.isSafeInteger(agreed.n) ? agreed.n : null;
    if (proofNonce === null && agreedNonce === null) throw agreed.e || new Error('No confirmed account nonce');
    const confirmed = agreedNonce !== null
      ? Math.max(agreedNonce, proofNonce === null ? 0 : proofNonce)
      : Math.max(proofNonce, await this._nonceHighWater(address));
    await this._setNonceHighWater(address, confirmed);
    return confirmed;
  }

  // The highest account nonce this device confirmed per address (see _confirmedAccountNonce).
  async _nonceHighWater(address) {
    try {
      const all = JSON.parse((await AsyncStorage.getItem(WalletManager.NONCE_HWM_KEY)) || '{}');
      const n = all && typeof all === 'object' ? all[address] : 0;
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  async _setNonceHighWater(address, nonce) {
    if (!Number.isSafeInteger(nonce) || nonce < 0) return;
    try {
      let all = {};
      try { all = JSON.parse((await AsyncStorage.getItem(WalletManager.NONCE_HWM_KEY)) || '{}') || {}; } catch (_) { all = {}; }
      if (typeof all !== 'object' || Array.isArray(all)) all = {};
      if (all[address] === nonce) return;
      all[address] = nonce;
      await AsyncStorage.setItem(WalletManager.NONCE_HWM_KEY, JSON.stringify(all));
    } catch (_) { /* kept next time */ }
  }

  static nonceReads = new Map(); // address -> the agreed nonce read in flight

  /**
   * The highest account nonce at least MIN_GENESIS_AGREEMENT genesis nodes report alike; throws NONCE_UNKNOWN when no
   * two agree. One read at a time per address (the send check and the nonce plan of one send ask together). It settles
   * as soon as no answer still out can change it (_settleGenesis): fewer are out than an agreement needs, and none of
   * them could still bring a higher value to an agreement.
   */
  _agreedGenesisNonce(address) {
    const running = WalletManager.nonceReads.get(address);
    if (running) return running;
    const read = this._agreedGenesisNonceNow(address).finally(() => {
      if (WalletManager.nonceReads.get(address) === read) WalletManager.nonceReads.delete(address);
    });
    WalletManager.nonceReads.set(address, read);
    return read;
  }

  async _agreedGenesisNonceNow(address) {
    let keyed = 0;
    const reads = GENESIS_NODES.map((base) => this._getJson(base, `/api/v1/account/${address}`, 4000).then((a) => {
      if (!a || !/^\d+$/.test(String(a.nonce))) return null;
      // The genesis answers also say whether the chain holds this wallet's key (pk elision), late ones included.
      if (a.has_dilithium_pk === true && ++keyed >= MIN_GENESIS_AGREEMENT) WalletManager.pkBound[address] = true;
      return Number(a.nonce);
    }, () => null));
    const countsOf = (list) => {
      const counts = new Map();
      for (const n of list) if (n !== null) counts.set(n, (counts.get(n) || 0) + 1);
      return counts;
    };
    const agreedOf = (counts) => [...counts].filter(([, n]) => n >= MIN_GENESIS_AGREEMENT).map(([nonce]) => nonce);
    const answers = await this._settleGenesis(reads, (got, left) => {
      if (left >= MIN_GENESIS_AGREEMENT) return false;
      const counts = countsOf(got);
      const agreed = agreedOf(counts);
      const top = agreed.length ? Math.max(...agreed) : -1;
      return ![...counts].some(([v, n]) => v > top && n + left >= MIN_GENESIS_AGREEMENT);
    });
    const agreed = agreedOf(countsOf(answers));
    if (agreed.length === 0) {
      throw Object.assign(new Error('The network could not confirm this wallet\'s transaction count. Try again in a moment.'),
        { code: 'NONCE_UNKNOWN' });
    }
    return Math.max(...agreed);
  }

  /**
   * The QNC balance at least two genesis nodes report for `address` right now (MOBNET-R3-04), in QNC, or null when no
   * two agree. The Assets tab takes a lower figure from this: one unproven answer may be a lagging node, two agreeing
   * genesis nodes are not, and without it a spend made from the in-app browser, the extension or anyone holding the
   * phrase would never lower the balance shown. Read as text, so a u64 past 2^53 nanoQNC stays exact.
   */
  agreedGenesisBalance(address) {
    if (!address) return Promise.resolve(null);
    // The same read within GENESIS_READ_REUSE_MS, or one in flight, is shared: the Assets tab, its refresh and a send
    // ask for the same figure at once (M14).
    const kept = WalletManager.genesisBalanceReads.get(address);
    if (kept && (kept.pending || Date.now() - kept.at < WalletManager.GENESIS_READ_REUSE_MS)) return kept.promise;
    const promise = this._agreedGenesisBalanceNow(address);
    const entry = { promise, pending: true, at: 0 };
    WalletManager.genesisBalanceReads.set(address, entry);
    promise.then(
      (v) => { entry.pending = false; entry.at = Date.now(); if (v === null) WalletManager.genesisBalanceReads.delete(address); },
      () => { WalletManager.genesisBalanceReads.delete(address); },
    );
    while (WalletManager.genesisBalanceReads.size > 8) {
      WalletManager.genesisBalanceReads.delete(WalletManager.genesisBalanceReads.keys().next().value);
    }
    return promise;
  }

  async _agreedGenesisBalanceNow(address) {
    const agreedOf = (list) => {
      const counts = new Map();
      for (const a of list) if (a !== null) counts.set(a, (counts.get(a) || 0) + 1);
      return [...counts].filter(([, n]) => n >= MIN_GENESIS_AGREEMENT).map(([v]) => BigInt(v));
    };
    const answers = await this._fromGenesis(async (base) => {
      const ctl = new AbortController();
      const guard = setTimeout(() => ctl.abort(), 4000);
      try {
        const r = await fetch(`${base}/api/v1/account/${encodeURIComponent(address)}`, { method: 'GET', signal: ctl.signal });
        if (!r.ok) return null;
        const data = parseStrictJson(await r.text());
        return data && typeof data === 'object' ? u64Text(data.balance) : null;
      } catch (_) {
        return null;
      } finally {
        clearTimeout(guard);
      }
    }, (list) => agreedOf(list).length > 0);
    const agreed = agreedOf(answers);
    if (agreed.length === 0) return null;
    // Two values each held by two nodes (a block in between): the higher one, never a guess below both.
    const best = agreed.reduce((a, b) => (b > a ? b : a));
    return Number(best) / 1e9;
  }

  /**
   * The answers of genesis nodes to `read(base)` for an agreement read: GENESIS_AGREEMENT_FIRST of them (in random
   * order) first, and the others only when `decided(answers)` says those gave no verdict yet. At scale every such read of
   * every wallet went to all five names (M14). A read that throws answers null.
   */
  // A verdict among the first ones stands once fewer answers are out than an agreement needs: with three asked and two
  // needed, the third cannot form a second agreement against two that agree, so it is not waited for.
  async _fromGenesis(read, decided) {
    const order = shuffledGenesisNodes();
    const first = order.slice(0, WalletManager.GENESIS_AGREEMENT_FIRST);
    const ask = (base) => Promise.resolve().then(() => read(base)).catch(() => null);
    const answers = await this._settleGenesis(first.map(ask), (got, left) => left < MIN_GENESIS_AGREEMENT && decided(got));
    if (order.length <= first.length || decided(answers)) return answers;
    const rest = await Promise.all(order.slice(first.length).map(ask));
    return [...answers, ...rest];
  }

  /**
   * The answers of `reads` (promises; one that rejects answers null), in the order they came: as soon as
   * `determined(answers, left)` says the `left` still out cannot change the outcome, else once all are in. Only when an
   * agreement read is decided changes, never what decides it; the reads still out run on and are ignored.
   */
  _settleGenesis(reads, determined) {
    return new Promise((resolve) => {
      const got = [];
      let left = reads.length;
      let done = false;
      const settleIfDecided = () => {
        if (done || (left > 0 && !determined(got, left))) return;
        done = true;
        resolve(got.slice());
      };
      if (left === 0) { settleIfDecided(); return; }
      for (const p of reads) {
        Promise.resolve(p).catch(() => null).then((v) => {
          got.push(v);
          left -= 1;
          settleIfDecided();
        });
      }
    });
  }

  /**
   * The nonce the next transaction from `address` takes: the confirmed account nonce, then this wallet's
   * own unsettled transactions (services/PendingTx) and, while there are any, the user's `choice` (replace one
   * of them or send in addition). { nonce, replaces, confirmed }: `replaces` is the unsettled transaction whose
   * nonce this one reuses, so only one of the two can apply. Throws PENDING_CHOICE when a choice is needed.
   */
  async resolveNonce(address, choice = null) {
    const confirmed = await this._confirmedAccountNonce(address);
    const live = await settle(address, confirmed);
    return { ...planNonce(confirmed, live, choice), confirmed };
  }

  /**
   * What a confirmation screen needs before a send: { confirmed, nonce (with nothing unsettled, else null),
   * live, replace, canAppend, recent }. `live` are this wallet's unsettled transactions and `replace` the one a
   * replacement takes the place of (services/PendingTx pendingChoices); `recent` the ones settled in the last
   * half hour, for the "same payment again" warning.
   */
  async previewSend(address) {
    const confirmed = await this._confirmedAccountNonce(address);
    const live = await settle(address, confirmed);
    const choices = pendingChoices(confirmed, live);
    return {
      confirmed, nonce: live.length ? null : confirmed + 1, ...choices, recent: await recentSettled(address),
    };
  }

  /** The nonce a choice made on a preview signs at (null when the choice is not valid for it). */
  static nonceForChoice(preview, choice) {
    if (!preview) return null;
    try {
      const live = preview.live.map((v) => ({ nonce: v.nonce, state: v.state, acceptedAt: v.held ? Date.now() : 0, bodyHash: v.bodyHash }));
      return planNonce(preview.confirmed, live, choice).nonce;
    } catch (_) {
      return null;
    }
  }

  /**
   * Signs and submits one nonce-bound transaction. `sign(nonce)` returns { path, body, pk }: the request
   * with its signature over that nonce, and the public key hex for a resend that has to carry it. The signed
   * request is kept before anything is sent, and every resend is those same bytes. Returns
   * { accepted: true, data, nonce, replaced } or { accepted: false, error, unknown }. One at a time.
   * `extra` describes the transaction ({ kind, to, amountNano, method }) for the screens and the resolver.
   */
  // `expectNonce`: the nonce a confirmation screen showed; another one throws NONCE_CHANGED before signing.
  // `choice`: what the user chose about this wallet's unsettled transactions (resolveNonce).
  // `oneInFlight` (a site's send): only the confirmed nonce + 1, the one nonce a node admits; any other throws
  // NONCE_CHANGED before signing (the extension's rule), so nothing is signed to wait behind an earlier transaction.
  async _signAndSubmit(from, sign, extra = {}, { expectNonce = null, choice = null, oneInFlight = false } = {}) {
    const lane = this._txLane || Promise.resolve();
    const run = lane.then(async () => {
      const plan = await this.resolveNonce(from, choice);
      if ((expectNonce !== null && plan.nonce !== expectNonce) || (oneInFlight && plan.nonce !== plan.confirmed + 1)) {
        const e = new Error('The wallet\'s next transaction number changed');
        e.code = 'NONCE_CHANGED';
        throw e;
      }
      const { path, body, pk } = await sign(plan.nonce);
      const summary = {
        kind: extra.kind || 'other',
        to: typeof extra.to === 'string' ? extra.to : null,
        amountNano: Number.isSafeInteger(extra.amountNano) ? extra.amountNano : null,
        method: typeof extra.method === 'string' ? extra.method : null,
        // The most QNC a call may still take from the balance (its most fee, and a token transfer's deposit): what a
        // later send in addition must leave for it (dappProvider spendableNano, MOB-BR-R3-02).
        reserveNano: Number.isSafeInteger(extra.reserveNano) && extra.reserveNano >= 0 ? extra.reserveNano : null,
      };
      // The most it can take (services/PendingTx ownSpends): what a send after it is checked against until the
      // certified state reaches its nonce.
      const spend = normalSpend(extra.spend);
      const entry = {
        from, nonce: plan.nonce, path, body, bodyHash: bodyHashOf(body), pk: pk || null, summary, spend, createdAt: Date.now(),
      };
      await putSigned(entry);
      WalletManager.lastOwnSendAt.set(from, Date.now());
      // A recipient the user signed for becomes a known one (sentRecipients), before anything is sent.
      await this._rememberRecipient(extra.kind === 'transfer' ? extra.to : extra.recipient, from).catch(() => {});
      const out = await this._sendPending(entry);
      const replaced = !!plan.replaces;
      if (out.accepted) return { accepted: true, data: out.data, nonce: plan.nonce, replaced };
      return {
        accepted: false, error: out.error,
        unknown: this._unknownOutcome(from, plan.nonce, {
          ...extra, refusal: out.error || null, refusalUncertain: !!out.uncertain, replaced,
        }),
      };
    });
    this._txLane = run.catch(() => {});
    return run;
  }

  /**
   * Sends a kept transaction to the genesis nodes: the same signed bytes every time. A node's refusal is
   * tried once more on other genesis nodes, since one node may lag. `pk_unresolved` (the node has no
   * committed key for us yet) is answered with the key attached: the same signature, the same transaction.
   */
  async _sendPending(entry) {
    let body = entry.body;
    let last = { accepted: false, error: null };
    const tried = [];
    // A request that ended with no answer may have reached its node: a refusal next to it is not final (MOBNET-R4-02).
    let unanswered = 0;
    // Every update names these exact bytes: an answer that comes back after the user replaced them changes nothing.
    const same = { bodyHash: entry.bodyHash || bodyHashOf(entry.body) };
    const took = (r) => !!(r && r.data && (r.data.tx_hash || r.data.success === true));
    const errorOf = (r) => {
      const d = (r && r.data) || {};
      return d.details ? `${d.error}: ${d.details}` : (d.error || `HTTP ${r && r.status}`);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const nodes = this.getTrustedNodes(GENESIS_NODES.length).filter((u) => !tried.includes(u)).slice(0, 2);
      if (nodes.length === 0) break;
      let res;
      try {
        // A refusal from one node does not cut off the other node's copy of the request: only an acceptance settles.
        res = await this._hedged(entry.path, { method: 'POST', body, timeoutMs: 8000, hedgeMs: 900, nodes, settleOn: took });
      } catch (e) {
        if (!WalletManager.isUnansweredSubmit(e)) last = { accepted: false, error: e.message };
        unanswered += 1;
        break;
      }
      const answers = res.answers || [res];
      for (const a of answers) tried.push(a.base);
      unanswered += res.unanswered || 0;
      if (took(res)) {
        const d = res.data;
        // What a node answered stands even when the kept copy cannot be updated right now (MOBNET-R5-04): the entry
        // stays as it was, and the chain settles it by nonce.
        await updateEntry(entry.from, entry.nonce, {
          state: 'accepted', acceptedAt: Date.now(), txHash: d.tx_hash || null,
          lastSentAt: Date.now(), sends: (entry.sends || 0) + attempt + 1, refusal: null, refusalUncertain: false,
        }, same).catch((e) => logger.warn('[WARN][PENDING] kept entry not updated', e && e.code));
        return { accepted: true, data: d };
      }
      const errors = answers.map(errorOf);
      last = { accepted: false, error: errors[0] };
      if (errors.some((x) => /pk_unresolved/i.test(x)) && entry.pk && !body.dilithium_public_key) {
        body = { ...body, dilithium_public_key: entry.pk };
        delete WalletManager.pkBound[entry.from];
      }
    }
    // A refusal is kept with the entry: one that waiting cannot heal (insufficient balance, a bad signature) stops
    // every automatic re-send at once (MOBNET-R3-01) — unless a request of this send went unanswered, whose node may
    // hold it: then it is sent again like one nobody answered, and the screens do not call it final (MOBNET-R4-02).
    const uncertain = !!last.error && unanswered > 0;
    const refused = last.error
      ? { refusal: String(last.error).slice(0, 300), refusedAt: Date.now(), refusalUncertain: uncertain } : {};
    if (last.error && !refusalHeals(last.error) && !uncertain) refused.stopped = 'refused';
    await updateEntry(entry.from, entry.nonce, { lastSentAt: Date.now(), sends: (entry.sends || 0) + 1, ...refused }, same)
      .catch((e) => logger.warn('[WARN][PENDING] kept entry not updated', e && e.code));
    return uncertain ? { ...last, uncertain } : last;
  }

  /**
   * Sends a kept, unsettled transaction again — the same bytes — at most every 10 s, for as long as its nonce is
   * free (the caller checks it is the account's next one). One a node accepted is sent again every RESEND_HELD_MS
   * (a node that restarted lost its mempool); each send that reaches a node extends how long it can still go through
   * (PendingTx mayLandUntil). What is sent is whatever is
   * kept at that nonce now: once the user replaced it, only the replacement goes out. Never by itself after
   * AUTO_SEND_MS from signing, nor after a refusal that waiting cannot heal (MOBNET-R3-01): a payment the screens
   * reported as not gone through must not go out days later. Such an entry is marked stopped and stays listed
   * (it keeps its nonce) until it settles, the user stops it, or a new send takes its place.
   */
  async rebroadcastPending(address, nonce) {
    const e = await pendingEntry(address, nonce);
    if (!e) return false;
    if (!autoSendable(e)) {
      if (!e.stopped) await updateEntry(address, nonce, { stopped: 'expired' }, { bodyHash: e.bodyHash || null });
      return false;
    }
    if (Date.now() - (e.lastSentAt || 0) < 10_000) return false;
    if (e.state === 'accepted' && Date.now() - (e.acceptedAt || e.createdAt || 0) < RESEND_HELD_MS) return false;
    return (await this._sendPending(e)).accepted;
  }

  /**
   * The sweep that keeps this wallet's unsettled transactions alive while the app is open (MOBNET-R2-04), run with
   * every balance refresh: settled entries go, and the one at the account's next nonce is sent again when no node
   * holds it. So a transaction signed "in addition" reaches a mempool as soon as the one before it applies, not
   * only while a result card is watching. The account nonce is the one the genesis nodes agree on.
   */
  async sendDuePending(address) {
    const kept = address ? await pendingFor(address) : [];
    if (kept.length === 0) return false;
    // Nothing the wallet still sends by itself (MOBNET-R3-01): the account nonce is read at most once a minute, only to
    // drop what settled, instead of five genesis reads with every balance refresh.
    const now = Date.now();
    if (!kept.some((e) => autoSendable(e, now)) && now - (this._keptSettleAt || 0) < 60_000) return false;
    this._keptSettleAt = now;
    const confirmed = await this._agreedGenesisNonce(address);
    if (!Number.isSafeInteger(confirmed)) return false;
    const live = await settle(address, confirmed);
    const next = live.find((e) => e.nonce === confirmed + 1);
    return next ? this.rebroadcastPending(address, next.nonce) : false;
  }

  // The QNet addresses this wallet signed transfers to (QNC and token transfers), oldest first, distinct, never its
  // own, at most SENT_RECIPIENTS_MAX: sealed under the vault's data key, so nothing written by anyone else, no
  // dust sender and no history page can make an address "known" (MOBNET-R2-03, the extension's ES-01 rule).
  static SENT_RECIPIENTS_KEY = 'qnet_sent_recipients';
  static SENT_RECIPIENTS_MAX = 128;

  async _readRecipients(s) {
    try {
      const rec = JSON.parse((await AsyncStorage.getItem(WalletManager.SENT_RECIPIENTS_KEY)) || 'null');
      if (!rec || rec.vault !== s.vaultId) return [];
      const r = await openRecord(s.dekKey, rec, 'sent-recipients');
      return Array.isArray(r && r.recipients) ? r.recipients.filter((a) => typeof a === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  async _rememberRecipient(to, from) {
    const s = this._session;
    if (!s || typeof to !== 'string' || !to) return;
    const addr = to.toLowerCase();
    if (from && addr === String(from).toLowerCase()) return;
    const current = await this._readRecipients(s);
    if (current.includes(addr)) return;
    const next = [...current, addr].slice(-WalletManager.SENT_RECIPIENTS_MAX);
    const rec = await sealRecord(s.dekKey, s.vaultId, { v: 1, recipients: next }, 'sent-recipients');
    if (this._session !== s) return; // locked, switched or rotated meanwhile
    await AsyncStorage.setItem(WalletManager.SENT_RECIPIENTS_KEY, JSON.stringify(rec));
  }

  /** The addresses this wallet signed transfers to (see SENT_RECIPIENTS_KEY); [] while locked. */
  async sentRecipients() {
    const s = this._session;
    return s ? this._readRecipients(s) : [];
  }

  /** This wallet's signed transactions the chain has not settled yet (services/PendingTx). */
  pendingTransactions(address) {
    return pendingFor(address);
  }

  /**
   * What the Assets tab lists about this wallet's kept transactions (MOBNET-R3-01): one view each (no signature,
   * no key), with whether the wallet still sends it by itself and whether the user may stop it.
   */
  async keptTransactions(address) {
    const now = Date.now();
    const list = await pendingFor(address);
    return list.map((e) => ({
      ...pendingView(e, now), canStop: stoppable(list, e.nonce, now), stopLandsUntil: stopLandsUntil(list, e.nonce),
    }));
  }

  /**
   * "Stop sending": deletes the kept transaction at `nonce` (while it is still `bodyHash`) and every kept one above
   * it, never while a node holds any of them. Resolves true when it deleted.
   */
  stopPendingTransaction(address, nonce, bodyHash) {
    return stopFrom(address, nonce, { bodyHash });
  }

  /** Summaries of this wallet's transactions settled in the last half hour, newest first (services/PendingTx). */
  recentSettledTransactions(address) {
    return recentSettled(address);
  }

  /**
   * A QNet address as the chain spells it, or a throw: EON (45 chars, checksum verified) or 64 hex, in
   * lowercase. Signing bytes that name a mistyped or differently-cased address would bind the signature
   * to an account nobody holds.
   */
  static canonicalAddress(address) {
    const a = String(address || '').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(a)) return a;
    if (/^[0-9a-f]{19}eon[0-9a-f]{23}$/.test(a)) {
      const { sha3_256 } = require('js-sha3');
      if (sha3_256(a.slice(0, 37)).slice(0, 8) !== a.slice(37)) {
        throw Object.assign(new Error('Invalid recipient address (checksum mismatch)'), { code: 'ADDRESS_CHECKSUM' });
      }
      return a;
    }
    throw Object.assign(new Error('Invalid address. EON (45 chars) or Hex (64 chars) required.'), { code: 'INVALID_ADDRESS' });
  }

  /**
   * Where value may go (MOBNET-R4-01): a QNet address a key can control, i.e. a checksummed EON address, lowercase.
   * The chain lets only an EON address sign (tx.from), so QNC, tokens or an NFT sent to 64 hex (a token contract, a
   * transaction hash, a state root, or a typo of one: 64 hex has no checksum) could never move again. The extension's
   * isValidQnetAddress and the in-app browser's send sheet take EON only too. 64 hex stays for what is a contract: a
   * call's target (canonicalAddress).
   */
  static recipientAddress(address) {
    const a = WalletManager.canonicalAddress(address);
    if (!/^[0-9a-f]{19}eon[0-9a-f]{23}$/.test(a)) {
      throw Object.assign(new Error('Not an address funds can be sent to: a 64-character hex value is a contract, a transaction or a hash, not an account'),
        { code: 'HEX_RECIPIENT' });
    }
    return a;
  }

  // PURE DILITHIUM (F0.1): the light node's on-chain attestation root, ping delegation, and reward-claim
  // proofs are ALL signed by the ML-DSA-65 WALLET key (the key whose SHA512 IS wallet_address). Returns it
  // as hex {secretKey, publicKey} for signWithDilithium — replaces the legacy per-node identity key so the
  // RAM quantum_pubkey == the on-chain root (load_vrf_public_key) and background/foreground pings verify.
  /// Re-derive the light node's identity-key cache from a decrypted wallet.
  ///
  /// The node verifies a ping delegation against the identity key the chain committed, and the app
  /// presents that key ONLY from `qnet_identity_pk_<id>` — a cache written once at registration and
  /// wiped by a reinstall. Without it every ping goes out with `identity_pubkey` absent and the node
  /// answers `identity_unresolved presented=false`, which is what the genesis logs showed. Nothing is
  /// actually lost: a light node's identity IS this wallet's ML-DSA-65 key and its id derives from the
  /// wallet address, so both come back with the seed.
  ///
  /// It lives HERE, not in a screen: the failing pings come from the background task, which reaches no
  /// screen and holds no password. Every decrypt and every store passes through this class, so this is
  /// the one place that cannot be routed around. Public half only, idempotent, no network.
  async cacheLightIdentityPk(wallet) {
    try {
      const pk = wallet && wallet.qnetKeypair && wallet.qnetKeypair.publicKey;
      const addr = wallet && wallet.qnetAddress;
      if (!pk || !addr) return;
      const key = `qnet_identity_pk_${this.generateLightNodePseudonym(addr)}`;
      if (await AsyncStorage.getItem(key)) return;
      const hex = Buffer.from(new Uint8Array(pk)).toString('hex');
      if (hex.length > 64) {
        await AsyncStorage.setItem(key, hex);
        logger.log('[Identity] ping identity key restored from wallet');
      }
    } catch (_) { /* best effort: a ping that cannot present still reports honestly */ }
  }

  /**
   * A website's message (the in-app browser's qnet_signMessage, confirmed on its sheet), signed like the browser
   * extension (crypto/OffchainMessage): { signature, publicKey, address } as hex, hex and EON. The key is
   * decrypted for this one signature and wiped.
   */
  async signOffchainMessage(origin, message, credential) {
    const wd = await this.loadWallet(credential);
    const qk = wd && wd.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey || !wd.qnetAddress) throw new Error('No ML-DSA-65 QNet key in wallet');
    const sk = new Uint8Array(qk.privateKey);
    const pk = new Uint8Array(qk.publicKey);
    try {
      const signed = signOffchainMessage(origin, message, sk, pk);
      if (signed.address !== wd.qnetAddress) throw new Error('The wallet key does not match its address');
      return {
        signature: Buffer.from(signed.signature).toString('hex'),
        publicKey: Buffer.from(pk).toString('hex'),
        address: signed.address,
      };
    } finally {
      sk.fill(0);
      if (Array.isArray(qk.privateKey) || qk.privateKey instanceof Uint8Array) qk.privateKey.fill(0);
    }
  }

  /**
   * A Solana transfer's message (services/SolanaSend), signed by the wallet's Solana key: the 64-byte Ed25519
   * signature. Only a one-signer legacy message this wallet pays for is signed. The key is re-made from its seed half and
   * must give this wallet's Solana address, so a signature is only ever made by the key the address names. The key is
   * decrypted for this one signature and wiped.
   */
  async signSolanaMessage(message, credential) {
    if (!(message instanceof Uint8Array) || message.length > PACKET_DATA_SIZE) throw new Error('Not a Solana message');
    const wd = await this.loadWallet(credential);
    const own = wd && (wd.solanaAddress || wd.address);
    if (!own || messageFeePayer(message) !== own) throw new Error('The message is not paid by this wallet');
    const stored = wd.secretKey;
    if (!stored || stored.length !== 64) throw new Error('No Solana key in wallet');
    const seed = Uint8Array.from(stored).subarray(0, 32);
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      if (base58Encode(pair.publicKey) !== own) throw new Error('The wallet key does not match its address');
      return nacl.sign.detached(message, pair.secretKey);
    } finally {
      seed.fill(0);
      pair.secretKey.fill(0);
      if (Array.isArray(stored) || stored instanceof Uint8Array) stored.fill(0);
    }
  }

  async _walletDilithiumKeys(password, walletData = null) {
    const wd = walletData || await this.loadWallet(password);
    const qk = wd && wd.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey) {
      throw new Error('No ML-DSA-65 QNet key in wallet (pure-Dilithium identity unavailable)');
    }
    const sk = new Uint8Array(qk.privateKey);
    const keys = {
      secretKey: Buffer.from(sk).toString('hex'),
      publicKey: Buffer.from(new Uint8Array(qk.publicKey)).toString('hex'),
    };
    sk.fill(0);
    // A wallet loaded here for this one signature does not keep its key array around.
    if (!walletData && Array.isArray(qk.privateKey)) qk.privateKey.fill(0);
    return keys;
  }

  /**
   * The decrypted wallet for a session token (or, from older call sites, the password). The payload holds
   * no recovery phrase (it is sealed apart; revealMnemonic is the only way to it). A wallet whose ML-DSA
   * key is re-derived here (an older identity), or whose payload still held the phrase, is sealed again
   * under the same data key.
   */
  async loadWallet(credential) {
    const { vault, dekKey, payload, migratedFrom } = await this._payloadFor(credential);
    let wallet = JSON.parse(payload);
    let sealed = vault;
    // An older version 4 payload still carries the phrase: it moves into its own sealed record, once.
    const phraseInPayload = typeof wallet.mnemonic === 'string' && wallet.mnemonic ? wallet.mnemonic : null;
    if (phraseInPayload) sealed = await withMnemonic(sealed, dekKey, phraseInPayload);

    const pathBefore = wallet.qnetKeypair && wallet.qnetKeypair.path;
    // Re-deriving an older identity is the one other use of the phrase.
    if (pathBefore !== 'QNET_WALLET_MLDSA65_fips204' && !wallet.mnemonic) {
      const phrase = await openMnemonic(sealed, dekKey).catch(() => null);
      if (phrase) wallet.mnemonic = phrase;
    }
    wallet = await this.migrateQNetAddress(wallet);
    delete wallet.mnemonic;
    if (phraseInPayload || (wallet.qnetKeypair && wallet.qnetKeypair.path !== pathBefore)) {
      await this._writeVault(await sealPayload(sealed, dekKey, JSON.stringify(wallet)));
    }
    this._assertIdentity(wallet);

    if (wallet.qnetAddress) {
      await AsyncStorage.setItem('qnet_address', wallet.qnetAddress);
      // Stamp the crypto scheme so getCurrentWallet (no-password path) never trusts an
      // address cached by the old round-3 build; a missing/old stamp = re-derive on unlock.
      await AsyncStorage.setItem('qnet_address_scheme', 'fips204');
    }

    wallet._migrated = !!migratedFrom;
    wallet._migratedFromVersion = migratedFrom || null;
    await this.cacheLightIdentityPk(wallet);
    return wallet;
  }

  // The stored ML-DSA key must be the one its address commits to; anything else is not this wallet.
  _assertIdentity(wallet) {
    const qk = wallet && wallet.qnetKeypair;
    if (!qk || qk.path !== 'QNET_WALLET_MLDSA65_fips204' || !qk.publicKey || !wallet.qnetAddress) return;
    if (eonFromPublicKeyBytes(new Uint8Array(qk.publicKey)) !== wallet.qnetAddress) {
      throw new Error('The wallet key does not match its address');
    }
  }

  // SOL balance on Solana devnet (config/nodes SOLANA_CLUSTER).
  async getBalance(publicKey) {
    // 2 attempts, rotating the Solana RPC endpoint on 429/failure; null (not 0) ⇒ keep last-known.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rpcUrl = attempt === 0 ? getSolanaRpcUrl() : rotateSolanaRpc();
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 'confirmed', as the send's quote reads it: the figure moves when a send is confirmed, not a poll later.
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [publicKey, { commitment: 'confirmed' }] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(t));
        if (response.ok) {
          const data = await response.json();
          const lamports = data && data.result ? data.result.value : undefined;
          // A JSON-RPC error answer carries no figure: a failed attempt, never a balance of 0.
          if (typeof lamports === 'number' && Number.isFinite(lamports) && lamports >= 0) return lamports / 1e9; // lamports → SOL
        }
      } catch (error) { /* rotate + retry */ }
    }
    return null;
  }

  // A Solana token's balance on Solana devnet (1DEV): what a send can move, by the rule MAX and the send use
  // (services/SolanaSend heldTokenBase: the fullest initialized account of this owner and mint, read at 'confirmed').
  // null (not 0) when it cannot be read ⇒ keep last-known; 0 only when the network answered and no account holds any.
  async getTokenBalance(walletAddress, mintAddress) {
    const token = SOLANA_TOKENS.find((tk) => tk.mint && tk.mint === mintAddress);
    if (!token) return null; // a mint the wallet does not list: its decimals are not known here
    try {
      return Number(fromBaseUnits(await heldTokenBase(walletAddress, mintAddress), token.decimals));
    } catch (_) {
      return null;
    }
  }

  // v3.36: DEPRECATED - Use getQNCBalanceWithProof() for ALL balance queries!
  // This method is kept only for backwards compatibility with internal code
  // For UI/display: ALWAYS use getQNCBalanceWithProof() - it's TRUSTLESS!
  // 
  // WHY: getQNCBalance() trusts the node response without Merkle verification
  // A malicious node could return fake balance. getQNCBalanceWithProof() prevents this.
  async getQNCBalance(address, maxRetries = 3) {
    const result = await this.getQNCBalanceWithProof(address, true, maxRetries);
    return result.ok ? result.balance : null;   // null on failure ⇒ caller keeps last-known
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v3.11: TRUSTLESS BALANCE VERIFICATION with Merkle Proofs
  // Light clients can verify balance without trusting the API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get QNC balance with Merkle proof for trustless verification
   * v3.35: Added retry logic with different nodes
   * @param {string} address - Wallet address
   * @param {boolean} verify - Whether to verify the proof
   * @returns {Promise<{balance: number, verified: boolean, proof: object}>}
   */
  // Returns { ok, balance, verified, index, ... }. ok=false ⇒ no answer with a proof: the caller MUST keep the
  // last-known balance, NEVER display a fabricated 0; `reason` says why: 'unanswered' (no node answered) or
  // 'unconfirmed' (answers came, none certified and recent). Hedged + health-ranked (send-path bar).
  // A read that names the wallet goes to genesis names only: a third-party operator never learns which address
  // this phone (its IP) holds, nor when it is about to send (a proof read precedes every send).
  // The certified form is asked for (?mb=, _proofPasses); a node from before it answers with its live-root proof,
  // which still counts when its root is a recent certified one.
  // `opts.onFigure(figure)`: called once with { balance, balanceNano, nonce, blockHeight } as soon as the answer is
  // read and its Merkle proof folded, before the lineage walk decides whether its state root is certified, so the
  // screen can show the figure (as not verified) while the walk runs; never for a 0. `opts.onAnswer()`: a node
  // answered. `opts.index`: the macroblock to ask for. A number in place of `opts` is an older caller's retry count and
  // means nothing.
  // Up to three genesis names are asked, one after another as each fails or answers with no proof that verifies.
  async getQNCBalanceWithProof(address, verify = true, opts = null) {
    const onFigure = opts && typeof opts.onFigure === 'function' ? opts.onFigure : null;
    const onAnswer = opts && typeof opts.onAnswer === 'function' ? opts.onAnswer : null;
    const index = opts && Number.isSafeInteger(opts.index) ? opts.index : null;
    return this._balanceProofFrom(address, verify, this.getTrustedNodes(3), onFigure, { index, onAnswer });
  }

  // A proof counts only when its macroblock is within this many of the chain head.
  static PROOF_MAX_LAG_MACROBLOCKS = 2;

  /**
   * Whether a verified proof is recent enough: a node could otherwise serve a genuinely certified but old
   * state (a balance from before a spend). The head is the higher of the newest macroblock this device verified
   * and the certified head the genesis nodes report (_networkHeadIndex); with none to be read, no proof counts.
   */
  // `known`: the head index already read for this check (null when it could not be), so it is not asked twice.
  async _proofIsFresh(blockHeight, known = undefined) {
    return this._indexIsFresh(Math.floor((Number(blockHeight) || 0) / 90), known);
  }

  // The same for the state certified at macroblock `idx` (the index whose certified root a proof's root is: a proof
  // is as recent as that checkpoint, whatever height its node named).
  async _indexIsFresh(idx, known = undefined) {
    const network = known === undefined ? await this._networkHeadIndex() : known;
    if (network === null) return false;
    const head = Math.max(highestVerifiedIndex(), network);
    return idx >= head - WalletManager.PROOF_MAX_LAG_MACROBLOCKS;
  }

  // The certified head the genesis nodes report: the second highest of their certified frontiers (newest certified
  // macroblock index), at least three answering (QcLightClient.certifiedHeadHint), cached for a minute; null when too
  // few answer. Never the applied tip a node reports: a certified index is judged against a certified frontier.
  async _networkHeadIndex() {
    const hint = this._headHint;
    if (hint && Date.now() - hint.at < 60_000) return hint.idx;
    const idx = await certifiedHeadHint(() => GENESIS_NODES);
    if (idx === null) return null;
    this._headHint = { idx, at: Date.now() };
    return idx;
  }

  /**
   * The nodes a macroblock lineage step is fetched from, in order: one from the read pool (spreads the load),
   * then every genesis name, then the rest of the pool. Nothing they serve is trusted: each step is verified.
   */
  _lineageNodes() {
    const first = this.getReadNodes(1);
    const genesis = this.getTrustedNodes(GENESIS_NODES.length).filter((u) => !first.includes(u));
    const rest = this.getReadNodes(12).filter((u) => !first.includes(u) && !genesis.includes(u));
    return [...first, ...genesis, ...rest];
  }

  // How long a walk waits for the anchors an earlier session kept to be read (_certifiedFresh).
  static ANCHORS_WAIT_MS = 3000;

  // A state root certified by the committee (QcLightClient.certifiedStateRootIndex: the checkpoint covering the proof's
  // height or one of the two before it) and recent by that checkpoint's index (_indexIsFresh). Whatever the walk
  // verified is kept (sealed) even when it did not reach this macroblock, so the next walk resumes there.
  // The anchors kept from an earlier session are read first (at most ANCHORS_WAIT_MS): a walk started before them
  // roots at the pin. The head the freshness check needs is read while the walk runs, not after it.
  async _certifiedFresh(stateRoot, blockHeight) {
    await this._anchorsLoaded();
    const head = this._networkHeadIndex().catch(() => null);
    const index = await certifiedStateRootIndex(stateRoot, blockHeight, () => this._lineageNodes(), this._lineageHooks());
    // Nothing certified: the head is not waited for.
    const ok = index !== null && await this._indexIsFresh(index, await head);
    this._saveVerifiedAnchors().catch(() => {});
    return ok;
  }

  async _anchorsLoaded() {
    if (!this._anchorsReady) return;
    let timer;
    await Promise.race([this._anchorsReady, new Promise((resolve) => { timer = setTimeout(resolve, WalletManager.ANCHORS_WAIT_MS); })])
      .finally(() => clearTimeout(timer));
  }

  /**
   * The committee-certified state root of macroblock `index`, for a certified proof that names it: { ok: true,
   * stateRoot } when the index is recent by the certified head (within PROOF_MAX_LAG_MACROBLOCKS below it, and never
   * past it by more: such an index is not walked to) and its QC verifies, walking up to that index only
   * (QcLightClient.certifiedStateRootAt); else { ok: false, reason: 'unconfirmed' }. The proof is folded to this root,
   * never to the one its node served.
   */
  async _certifiedRootFresh(index) {
    await this._anchorsLoaded();
    const network = await this._networkHeadIndex().catch(() => null);
    if (network === null || !Number.isSafeInteger(index)) return { ok: false, reason: 'unconfirmed' };
    const head = Math.max(highestVerifiedIndex(), network);
    const lag = WalletManager.PROOF_MAX_LAG_MACROBLOCKS;
    if (index < head - lag || index > head + lag) return { ok: false, reason: 'unconfirmed' };
    const r = await certifiedStateRootAt(index, () => this._lineageNodes(), this._lineageHooks());
    this._saveVerifiedAnchors().catch(() => {});
    return r.ok ? { ok: true, stateRoot: r.stateRoot } : { ok: false, reason: 'unconfirmed', why: r.reason };
  }

  // The size a balance or token proof answer may have (a certified one is a few KB): a longer one is no answer.
  static PROOF_ANSWER_MAX_BYTES = 64 * 1024;
  // For this long after this wallet's own send its proofs ask for the newest certified state ('latest').
  static OWN_SEND_LATEST_MS = 10 * 60_000;
  static lastOwnSendAt = new Map(); // address -> when a transaction from it was last signed here
  static retryAfterUntil = new Map(); // base -> until when it asked to be left alone (a 429 or 503 with a wait)

  static _noteRetryAfter(base, r, body) {
    let s = null;
    try {
      const h = r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null;
      if (h !== null && h !== undefined && /^\d{1,5}$/.test(String(h).trim())) s = Number(String(h).trim());
    } catch (_) { /* no headers to read */ }
    if (s === null && body && typeof body === 'object' && Number.isFinite(Number(body.retry_after_seconds))) {
      s = Number(body.retry_after_seconds);
    }
    if (s === null || !base) return;
    const map = WalletManager.retryAfterUntil;
    map.delete(base);
    map.set(base, Date.now() + Math.min(60_000, Math.max(1000, s * 1000)));
    while (map.size > 64) map.delete(map.keys().next().value);
  }

  // The nodes a proof is asked of, in order: first those neither waiting out a Retry-After nor marked as answering
  // with the older proof (QcLightClient.markNodeOld, for OLD_NODE_MARK_MS), then the marked ones, the waiting ones last.
  _proofOrder(nodes) {
    const now = Date.now();
    const waiting = (u) => (WalletManager.retryAfterUntil.get(u) || 0) > now;
    const list = Array.isArray(nodes) ? nodes : [];
    return [
      ...list.filter((u) => !waiting(u) && !nodeMarkedOld(u, now)),
      ...list.filter((u) => !waiting(u) && nodeMarkedOld(u, now)),
      ...list.filter((u) => waiting(u)),
    ];
  }

  // The macroblock a proof asks for: the newest this device verified while it is still within the freshness window of
  // the certified head read last (no new committee check is needed until it leaves it), else the newest the node holds
  // (null: 'latest'). For OWN_SEND_LATEST_MS after this wallet's own send: 'latest', so the send shows once certified.
  _proofIndex(address) {
    const hint = this._headHint;
    if (!hint || Date.now() - hint.at >= 60_000) return null;
    const sent = WalletManager.lastOwnSendAt.get(address);
    if (sent && Date.now() - sent < WalletManager.OWN_SEND_LATEST_MS) return null;
    const i = highestVerifiedIndex();
    const head = Math.max(i, hint.idx);
    return i >= trustFloorIndex() && i >= head - WalletManager.PROOF_MAX_LAG_MACROBLOCKS ? i : null;
  }

  /**
   * Reads one proof answer after another from `nodes` (each node at most once a pass) for `path` + `?mb=` each of
   * `passes` (a pinned index, then 'latest'; a later pass only when the earlier one got answers). `judge(res)` reads a
   * 200 answer: { verified: result } ends it, { figure } keeps the first figure whose proof folded under the root its
   * node served. Any answer without a verifiable proof is no answer: the next node is asked.
   * { verified } | { figure, answered, error }.
   */
  async _proofAnswers(path, nodes, passes, judge) {
    let figure = null;
    let answered = false;
    let error = 'no answer';
    for (const mb of passes) {
      const tried = [];
      for (;;) {
        const left = this._proofOrder(nodes).filter((u) => !tried.includes(u));
        if (left.length === 0) break;
        let res;
        try {
          res = await this._hedged(`${path}?mb=${mb}`, {
            timeoutMs: 5000, hedgeMs: 800, raw: true, nodes: left, maxBytes: WalletManager.PROOF_ANSWER_MAX_BYTES,
          });
        } catch (e) {
          error = e.message;
          break;
        }
        if (!res.ok || !res.data) {
          error = res.rateLimited ? 'rate limited' : `HTTP ${res.status}`;
          break;
        }
        tried.push(left.includes(res.base) ? res.base : left[0]);
        answered = true;
        const got = await judge(res);
        if (got.verified) return { verified: got.verified };
        if (got.figure && !figure) figure = got.figure;
        if (got.error) error = got.error;
      }
      if (!answered) break;
    }
    return { figure, answered, error };
  }

  // The passes of a proof read: an index the caller names, else the pinned one (_proofIndex) then 'latest'.
  _proofPasses(address, index) {
    if (Number.isSafeInteger(index)) return [String(index)];
    const pinned = this._proofIndex(address);
    return pinned === null ? ['latest'] : [String(pinned), 'latest'];
  }

  // A node that served a failing lineage step counts against its health; every verified step is kept. One that
  // answered with more than the size bound leaves the read pool for the rest of the session (MOBNET-R2-06). Registry
  // snapshots, whose size decides how long the phone hashes, come from the genesis names only (MOBNET-R5-02).
  _lineageHooks() {
    return {
      onNodeFailure: (base, reason) => {
        this._recordNode(base, false, 0);
        if (reason === 'oversized' && !GENESIS_NODES.includes(base)) WalletManager.droppedForSession.add(base);
      },
      onProgress: () => { this._saveVerifiedAnchors().catch(() => {}); },
      registryNodes: () => this.getTrustedNodes(GENESIS_NODES.length),
      onLineageReset: () => { this._dropStoredAnchors(); },
    };
  }

  async _balanceProofFrom(address, verify, nodes, onFigure = null, { index = null, onAnswer = null } = {}) {
    if (!address || typeof address !== 'string') {
      return { ok: false, balance: null, verified: false, error: 'Invalid address', reason: 'unanswered' };
    }
    let shown = false;
    // The figure as soon as its proof folded under the root its node served, before the lineage walk decides whether
    // that root is certified: shown as not verified meanwhile. Never a 0 nothing verified.
    const early = (figure, folded) => {
      if (!onFigure || shown || figure.balanceNano === '0') return;
      shown = true;
      try {
        onFigure({ balance: figure.balance, balanceNano: figure.balanceNano, nonce: figure.nonce, blockHeight: figure.blockHeight, folded });
      } catch (_) { /* the screen's update never stops the read */ }
    };
    const got = await this._proofAnswers(`/api/v1/account/${address}/balance/proof`, nodes, this._proofPasses(address, index),
      (res) => {
        if (onAnswer) { try { onAnswer(); } catch (_) { /* the caller's note never stops the read */ } }
        return this._judgeAccountAnswer(address, res, verify, early);
      });
    if (got.verified) {
      const r = got.verified;
      // A certified answer is what the next send check may use again (certifiedQncForSend).
      WalletManager._keepSendProof(`qnc|${address}`, {
        ok: true, verified: true, balanceNano: r.balanceNano, nonce: r.nonce, balance: r.balance, index: r.index,
      }, r.stateRoot, r.index);
      return r;
    }
    if (got.figure && (!verify || got.figure.balanceNano !== '0')) return { ok: true, verified: false, ...got.figure, reason: 'unconfirmed' };
    if (!got.answered) logger.warn('[BALANCE] proof fetch failed:', got.error);
    return { ok: false, balance: null, verified: false, error: got.error, reason: got.answered ? 'unconfirmed' : 'unanswered' };
  }

  /**
   * One 200 answer of the account balance proof route, read by one strict parse (the value shown is the value
   * verified: a repeated key anywhere refuses it, u64 values stay exact past 2^53). A certified answer (proof_format 2)
   * folds to the committee-certified root of the macroblock it names (_certifiedRootFresh); an answer of a node from
   * before certified proofs (it ignores the query) folds to its node's live root, which counts only when that root is
   * a recent certified one (_certifiedFresh), and marks the node old when its shape says so.
   */
  async _judgeAccountAnswer(address, res, verify, early) {
    let data;
    try { data = parseStrictJson(res.data); } catch (_) { return { error: 'bad json' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'bad json' };
    if (data.proof_format !== undefined) {
      const r = readCertifiedAccount(data, address, sha3Hex);
      if (!r.ok) return { error: 'bad proof' };
      const figure = {
        balance: Number(r.account.balance) / 1e9, balanceNano: r.account.balance, nonce: r.account.nonce,
        index: r.index, blockHeight: r.index * 90, exists: r.account.exists,
      };
      if (!verify) return { figure };
      const folded = typeof data.state_root === 'string' && r.fold(data.state_root);
      early(figure, folded);
      const root = await this._certifiedRootFresh(r.index);
      if (root.ok && r.fold(root.stateRoot)) {
        return { verified: { ok: true, verified: true, ...figure, stateRoot: root.stateRoot, proof: data.merkle_proof } };
      }
      return { figure: folded ? figure : null, error: 'unconfirmed' };
    }
    if (isLegacyProofBody(data, 'account')) markNodeOld(res.base);
    const balanceNanoStr = u64Text(data.balance);
    const nonceStr = u64Text(data.nonce);
    if (balanceNanoStr === null || nonceStr === null) return { error: 'bad proof' };
    // Every leaf input the older body carries (last_claimed_epoch, is_node, the heartbeat tally, the ban height).
    const lceStr = data.last_claimed_epoch === undefined ? '0' : u64Text(data.last_claimed_epoch);
    if (lceStr === null) return { error: 'bad proof' };
    const extra = {};
    for (const k of ['heartbeat_epoch', 'heartbeat_final_epoch', 'banned_at_height']) {
      extra[k] = data[k] === undefined ? '0' : u64Text(data[k]);
      if (extra[k] === null) return { error: 'bad proof' };
    }
    for (const k of ['heartbeat_slots', 'heartbeat_final_slots']) {
      extra[k] = data[k] === undefined ? 0 : data[k];
      if (!Number.isInteger(extra[k]) || extra[k] < 0 || extra[k] > 0xffff) return { error: 'bad proof' };
    }
    const isNode = data.is_node === true;
    const figure = {
      balance: Number(balanceNanoStr) / 1e9, balanceNano: balanceNanoStr, nonce: nonceStr,
      blockHeight: data.block_height, stateRoot: data.state_root, index: null,
    };
    if (!verify) return { figure };
    const proofValid = Array.isArray(data.merkle_proof) && data.merkle_proof.length > 0
      && await this.verifyMerkleProof(address, balanceNanoStr, nonceStr, data.merkle_proof, data.state_root, lceStr, isNode, extra);
    early(figure, proofValid);
    if (!proofValid) return { error: 'bad proof' };
    if (await this._certifiedFresh(data.state_root, data.block_height)) {
      return { verified: { ok: true, verified: true, ...figure, proof: data.merkle_proof } };
    }
    return { figure, error: 'unconfirmed' };
  }

  // V2: TRUSTLESS QRC-20 balance — exactly the getQNCBalanceWithProof trust model, one level deeper.
  //   GET /api/v1/token/{contract}/{holder}/balance/proof?mb= -> two-level proof (the contract account under the
  // certified state root, the holder's entry under the storage root that account commits to). `verified` is true only
  // when both levels fold to the committee-certified root (_judgeTokenAnswer). Balance is exact u64 text.
  // Names the holder, so genesis names only (see getQNCBalanceWithProof). `opts.index`: the macroblock to ask for (a
  // send check pairs it with the holder's QNC proof at the same index).
  async getTokenBalanceWithProof(contract, holder, decimals = null, verify = true, opts = null) {
    const index = opts && Number.isSafeInteger(opts.index) ? opts.index : null;
    return this._tokenProofFrom(contract, holder, decimals, verify, this.getTrustedNodes(3), { index });
  }

  async _tokenProofFrom(contract, holder, decimals, verify, nodes, { index = null } = {}) {
    if (!contract || !holder) return { ok: false, balance: null, verified: false, error: 'bad args', reason: 'unanswered' };
    const got = await this._proofAnswers(`/api/v1/token/${contract}/${holder}/balance/proof`, nodes,
      this._proofPasses(holder, index), (res) => this._judgeTokenAnswer(contract, holder, res, verify));
    const shaped = (f, verified) => ({
      ok: true, balance: decimals != null ? this._formatBaseUnits(f.balanceBase, decimals) : f.balanceBase,
      balanceBase: f.balanceBase, verified, blockHeight: f.blockHeight, stateRoot: f.stateRoot, index: f.index,
    });
    if (got.verified) {
      const f = got.verified;
      WalletManager._keepSendProof(`token|${contract}|${holder}`, { balanceBase: f.balanceBase }, f.stateRoot, f.index);
      return shaped(f, true);
    }
    // Never a 0 nothing verified.
    if (got.figure && (!verify || got.figure.balanceBase !== '0')) return { ...shaped(got.figure, false), reason: 'unconfirmed' };
    return { ok: false, balance: null, verified: false, error: got.error, reason: got.answered ? 'unconfirmed' : 'unanswered' };
  }

  // One 200 answer of the token balance proof route, by one strict parse (a nested or repeated "token_balance" can never
  // be displayed beside a proof of another value). Certified and older answers as in _judgeAccountAnswer; both levels
  // are bound to the REQUESTED (contract, holder), else a valid proof for another token or holder would pass.
  async _judgeTokenAnswer(contract, holder, res, verify) {
    let data;
    try { data = parseStrictJson(res.data); } catch (_) { return { error: 'bad json' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'bad json' };
    if (data.proof_format !== undefined) {
      const r = readCertifiedToken(data, contract, holder, sha3Hex);
      if (!r.ok) return { error: 'bad proof' };
      const figure = { balanceBase: r.balanceBase, index: r.index, blockHeight: r.index * 90, status: r.status };
      if (!verify) return { figure };
      const folded = typeof data.state_root === 'string' && r.fold(data.state_root);
      const root = await this._certifiedRootFresh(r.index);
      if (root.ok && r.fold(root.stateRoot)) return { verified: { ...figure, stateRoot: root.stateRoot } };
      return { figure: folded ? figure : null, error: 'unconfirmed' };
    }
    if (isLegacyProofBody(data, 'token')) markNodeOld(res.base);
    // token_balance is the stored decimal string the storage leaf commits to, byte for byte.
    const raw = data.token_balance === undefined ? '0' : data.token_balance;
    const baseUnitsStr = typeof raw === 'number' ? u64Text(raw) : (typeof raw === 'string' && /^\d{1,20}$/.test(raw) ? raw : null);
    if (baseUnitsStr === null) return { error: 'bad proof' };
    const figure = { balanceBase: baseUnitsStr, blockHeight: data.block_height, stateRoot: data.state_root, index: null };
    if (!verify) return { figure };
    if (!Array.isArray(data.storage_proof) || !Array.isArray(data.account_proof)) return { error: 'bad proof' };
    if (!(await this.verifyTokenBalanceProof({ ...data, token_balance: baseUnitsStr }, contract, holder))) return { error: 'bad proof' };
    if (await this._certifiedFresh(data.state_root, data.block_height)) return { verified: figure };
    return { figure, error: 'unconfirmed' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QRC-20 token READ path — hedged/health-ranked GETs (mirror getQNCBalanceWithProof)
  // ═══════════════════════════════════════════════════════════════════════════

  // Scale a raw u64 base-unit string to a human decimal string using ITS OWN decimals.
  // Pure BigInt/string math — NEVER float, so full u64 precision survives (a token can hold
  // far more than 2^53 base units). Trailing fractional zeros are trimmed; integer-only tokens
  // (decimals=0) return the integer as-is. Matches the on-chain u64 semantics exactly.
  _formatBaseUnits(baseUnitsStr, decimals) {
    const d = Number(decimals) || 0;
    let s = String(baseUnitsStr == null ? '0' : baseUnitsStr).trim();
    if (!/^\d+$/.test(s)) s = '0';
    if (d <= 0) return s;
    s = s.replace(/^0+(?=\d)/, ''); // strip leading zeros but keep a single 0
    const padded = s.padStart(d + 1, '0');
    const intPart = padded.slice(0, padded.length - d);
    const fracPart = padded.slice(padded.length - d).replace(/0+$/, '');
    return fracPart ? `${intPart}.${fracPart}` : intPart;
  }

  // Held QRC-20 tokens for a QNet account.
  //   GET /api/v1/account/{addr}/tokens -> [{contract_address, balance, name, symbol, decimals}]
  // Returns [{contract, name, symbol, decimals, balance}] with `balance` a HUMAN decimal string
  // scaled by 10**decimals (BigInt-safe). Raw text parse keeps u64 balances exact past 2^53.
  async getTokenHoldings(qnetAddress) {
    if (!qnetAddress || typeof qnetAddress !== 'string') return [];
    let res;
    try {
      res = await this._hedged(`/api/v1/account/${qnetAddress}/tokens`, { timeoutMs: 5000, hedgeMs: 800, raw: true });
    } catch (e) {
      logger.warn('[QRC20] holdings fetch failed:', e.message);
      return [];
    }
    if (!res.ok || !res.data) return [];
    let list;
    try {
      const parsed = JSON.parse(res.data);
      list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.tokens) ? parsed.tokens : []);
    } catch (_) {
      return [];
    }
    // Balances are u64 base units — pull them as exact strings from the raw text so a JSON number
    // never truncates above 2^53. Contract addresses are hex (no regex-special chars), so match each
    // holding's balance to its own contract directly in the untouched text.
    return list.map((t) => {
      const contract = t.contract_address || t.contract || '';
      const decimals = Number(t.decimals) || 0;
      // Prefer the string-exact balance the node emits; JSON.parse of a large number loses precision.
      let balanceStr = t.balance != null ? String(t.balance) : '0';
      if (contract && /^[0-9a-fA-F]+$/.test(contract)) {
        // Re-extract this contract's balance as a raw string (BigInt-safe) from the untouched text.
        const re = new RegExp(`"contract_address"\\s*:\\s*"${contract}"[^}]*?"balance"\\s*:\\s*"?(\\d+)"?`);
        const alt = new RegExp(`"balance"\\s*:\\s*"?(\\d+)"?[^}]*?"contract_address"\\s*:\\s*"${contract}"`);
        const m = re.exec(res.data) || alt.exec(res.data);
        if (m) balanceStr = m[1];
      }
      return {
        contract,
        name: t.name || t.symbol || 'Token',
        symbol: t.symbol || '',
        decimals,
        logo: typeof t.logo === 'string' ? t.logo : '',
        balance: this._formatBaseUnits(balanceStr, decimals),
        // The base units as the node reported them: the screen scales them with the decimals the user's added-token
        // record holds, never with the ones in this answer (MOBNET-R3-05).
        balanceBase: /^\d+$/.test(balanceStr) ? balanceStr : '0',
      };
    }).filter((t) => t.contract);
  }

  /**
   * The token a GET /api/v1/token/{contract} answer describes: { success: true, token: { contract_address, standard,
   * name, symbol, decimals, logo, total_supply, deployer } } → { contract, standard, name, symbol, decimals, logo,
   * totalSupply, deployer }, or null for a miss ("Token not found", a contract that is no token) or another contract.
   */
  static tokenInfoOf(body, contract) {
    const tk = body && typeof body === 'object' && body.success === true && body.token && typeof body.token === 'object'
      ? body.token : null;
    if (!tk || tk.contract_address !== contract || !Number.isInteger(tk.decimals) || tk.decimals < 0 || tk.decimals > 255) return null;
    const text = (v) => (typeof v === 'string' ? v : '');
    return {
      contract,
      standard: text(tk.standard),
      name: text(tk.name),
      symbol: text(tk.symbol),
      decimals: tk.decimals,
      logo: text(tk.logo),
      totalSupply: typeof tk.total_supply === 'string' ? tk.total_supply : null,
      deployer: typeof tk.deployer === 'string' && tk.deployer ? tk.deployer : null,
    };
  }

  // Token metadata for a contract (GET /api/v1/token/{addr}, one node). Returns {contract, name, symbol, decimals,
  // logo, totalSupply, deployer} or null when the contract is not a token / not found (so the Add-Token flow can reject
  // an invalid address honestly).
  async getTokenInfo(contractAddress) {
    if (!contractAddress || typeof contractAddress !== 'string') return null;
    let res;
    try {
      res = await this._hedged(`/api/v1/token/${contractAddress}`, { timeoutMs: 5000, hedgeMs: 800 });
    } catch (e) {
      logger.warn('[QRC20] token info fetch failed:', e.message);
      return null;
    }
    const info = res && res.ok ? WalletManager.tokenInfoOf(res.data, contractAddress) : null;
    if (!info) return null;
    // '' logo ⇒ the client renders a generated avatar.
    return { ...info, name: info.name || info.symbol || 'Token' };
  }

  // How long an agreed token description is reused: the in-app browser reads it for every token request of a site.
  static TOKEN_INFO_TTL_MS = 5 * 60_000;
  static TOKEN_INFO_CACHE_MAX = 64;
  static agreedTokens = new Map(); // contract → { at, info }

  /**
   * A token's description as at least two genesis nodes report it (GET /api/v1/token/{contract}; no proof covers it):
   * { contract, standard, name, symbol, decimals, ... }, or null when they agree the contract is no token. Throws
   * TOKEN_UNAVAILABLE when fewer than two answer or no two agree. An agreed token is reused for TOKEN_INFO_TTL_MS.
   */
  async agreedTokenInfo(contract) {
    const kept = WalletManager.agreedTokens.get(contract);
    if (kept && Date.now() - kept.at < WalletManager.TOKEN_INFO_TTL_MS) return kept.info;
    const agreedOf = (list) => {
      const counts = new Map();
      for (const a of list) {
        if (a === undefined) continue;
        const info = WalletManager.tokenInfoOf(a, contract);
        const key = info ? JSON.stringify([info.standard, info.name, info.symbol, info.decimals]) : 'none';
        const entry = counts.get(key) || { info, n: 0 };
        entry.n += 1;
        counts.set(key, entry);
      }
      return [...counts.values()].find((e) => e.n >= MIN_GENESIS_AGREEMENT);
    };
    const answers = await this._fromGenesis((base) =>
      this._getJson(base, `/api/v1/token/${encodeURIComponent(contract)}`, 4000).catch(() => undefined), (list) => !!agreedOf(list));
    const agreed = agreedOf(answers);
    if (!agreed) throw Object.assign(new Error('The token could not be read'), { code: 'TOKEN_UNAVAILABLE' });
    if (agreed.info) {
      WalletManager.agreedTokens.delete(contract);
      WalletManager.agreedTokens.set(contract, { at: Date.now(), info: agreed.info });
      while (WalletManager.agreedTokens.size > WalletManager.TOKEN_INFO_CACHE_MAX) {
        WalletManager.agreedTokens.delete(WalletManager.agreedTokens.keys().next().value);
      }
    }
    return agreed.info;
  }

  // The node's answers for an address that holds no built-in token (GET /api/v1/token/{address}).
  static NOT_A_TOKEN = 'Contract exists but is not a QRC-20/QRC-721 token';
  static NO_TOKEN = 'Token not found';

  /** What one node's token answer says `address` is: 'token', 'contract' (no token), 'none', or null (no verdict). */
  static contractKindOf(body, address) {
    if (!body || typeof body !== 'object') return null;
    if (body.success === false) {
      if (body.error === WalletManager.NOT_A_TOKEN) return 'contract';
      return body.error === WalletManager.NO_TOKEN ? 'none' : null;
    }
    const info = WalletManager.tokenInfoOf(body, address);
    return info && (info.standard === 'qrc20' || info.standard === 'qrc721') ? 'token' : null;
  }

  /**
   * What `address` is on chain as at least two genesis nodes agree: a built-in token, another contract, or nothing
   * ('token' | 'contract' | 'none'; the extension's readContract). The in-app browser sends a site's contract call only
   * to a contract that is no token. Throws TOKEN_UNAVAILABLE when no two agree.
   */
  async agreedContractKind(address) {
    const agreedOf = (list) => ['token', 'contract', 'none']
      .find((k) => list.filter((a) => a === k).length >= MIN_GENESIS_AGREEMENT);
    const answers = await this._fromGenesis((base) =>
      this._getJson(base, `/api/v1/token/${encodeURIComponent(address)}`, 4000)
        .then((a) => WalletManager.contractKindOf(a, address), () => null), (list) => !!agreedOf(list));
    const agreed = agreedOf(answers);
    if (!agreed) throw Object.assign(new Error('The contract could not be read'), { code: 'TOKEN_UNAVAILABLE' });
    return agreed;
  }

  /**
   * Why `to` may not be paid QNC or a built-in token, or null (the extension's assertPayableRecipient, MOB-BR-R3-01):
   * 'contract' when two genesis nodes agree it is a contract account (a built-in token, the token being sent included,
   * or another contract; none has a key, and no contract sends QNC or a token on, so what it is paid stays there for
   * good), 'unchecked' when no two agree. `from`, the wallet's own address, is no contract and is not read.
   */
  async payableRecipientProblem(to, from = null) {
    let address;
    try {
      address = WalletManager.recipientAddress(to);
    } catch (_) {
      return 'contract'; // not an account a key controls (MOBNET-R4-01)
    }
    if (from && address === String(from).trim().toLowerCase()) return null;
    let kind;
    try {
      kind = await this.agreedContractKind(address);
    } catch (_) {
      return 'unchecked';
    }
    return kind === 'none' ? null : 'contract';
  }

  static CUSTOM_TOKENS_KEY = 'qnet_custom_tokens';

  /** The tokens the user added to the Assets list: [{ contract_address, name, symbol, decimals, logo }]. */
  async addedTokens() {
    try {
      const list = JSON.parse((await AsyncStorage.getItem(WalletManager.CUSTOM_TOKENS_KEY)) || '[]');
      return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
    } catch (_) {
      return [];
    }
  }

  // Decoded QRC-20/721 token-transfer events for an account (effect-sourced, success-gated).
  //   GET /api/v1/account/{addr}/token-transfers?limit=N
  // Each row embeds its token metadata (symbol/decimals/logo) — no extra fetch. `amount` is a u64
  // base-unit DECIMAL STRING (quoted in JSON, so JSON.parse keeps it exact). Returns the transfers
  // array, or [] on any error/miss. Never throws.
  async getAccountTokenTransfers(address, limit = 50) {
    if (!address || typeof address !== 'string') return [];
    let res;
    try {
      res = await this._hedged(`/api/v1/account/${address}/token-transfers?limit=${limit}`, { timeoutMs: 5000, hedgeMs: 800 });
    } catch (e) {
      logger.warn('[QRC20] token transfers fetch failed:', e.message);
      return [];
    }
    if (!res.ok || !res.data || typeof res.data !== 'object') return [];
    return Array.isArray(res.data.transfers) ? res.data.transfers : [];
  }

  // P4 trustless check for ONE token transfer: fetch its /logs/proof, BIND the proven leaf to this
  // row's own fields, verify the merkle inclusion, then anchor the window logs_root to a committee-QC-
  // certified Checkpoint.logs_root. `row` = the decoded transfer row (contract/from/to/amount/kind/std/
  // token_id/tx_hash/log_index). True ONLY on a full cryptographic proof of THIS row; false for
  // pending-finality / unreachable / forged (caller keeps those unverified, never dropping a legit row).
  // Returns: 'verified' (leaf-bound + merkle + committee-QC anchored), 'consistent' (leaf folds to the
  // node-claimed root but the window is below the trust floor / not QC-anchorable now — real but unproven),
  // 'rejected' (leaf ≠ this row's fields, or the proof doesn't fold → forged), or 'pending' (transient
  // fetch/finality miss → retry). Caller shows only 'verified' with the trust badge.
  async verifyTokenTransferInclusion(row) {
    if (!row || typeof row !== 'object' || !row.tx_hash || typeof row.tx_hash !== 'string') return 'rejected';
    let res;
    try {
      res = await this._hedged(`/api/v1/logs/proof?tx_hash=${row.tx_hash}&log_index=${row.log_index || 0}`, { timeoutMs: 5000, hedgeMs: 800 });
    } catch (_) { return 'pending'; }
    const d = res && res.data;
    if (!res || !res.ok || !d || d.error || !d.leaf || !Array.isArray(d.proof) ||
        !d.block_root || !Array.isArray(d.window_proof) || !d.logs_root) return 'pending';
    // BIND: the proven leaf MUST equal the leaf recomputed from THIS row's own fields — else a node
    // replayed a real transfer's proof under a forged row. This check is what makes P4 reject forgeries.
    const expected = transferLogLeaf(row);
    if (!expected || expected !== String(d.leaf).toLowerCase()) return 'rejected';
    // SHARDED 2-level proof: level 1 folds the leaf → this block's sub-root; level 2 folds that sub-root →
    // the window logs_root. BOTH must hold — the node cannot substitute a block sub-root it did not commit.
    if (!verifyLogInclusion(d.leaf, d.proof, d.block_root)) return 'rejected';
    if (!verifyLogWindowInclusion(d.block_root, d.window_proof, d.logs_root)) return 'rejected';
    // Leaf folds to the node-CLAIMED root (self-consistent, a malicious node can fabricate this), so
    // QC-anchor the root to the committee signature for real trust. 'mismatch' = the committee-signed
    // root differs from the node's claim → a proven forgery, must be rejected (never confirmed).
    const anchored = await verifyMacroblockLogsRoot(d.logs_root, d.window_end, () => this._lineageNodes(), this._lineageHooks());
    this._saveVerifiedAnchors().catch(() => {});
    if (anchored === true) return 'verified';
    if (anchored === 'mismatch') return 'rejected';
    return 'consistent'; // below trust floor / macroblock unreachable — real but unprovable now
  }

  // Raw + scaled QRC-20 balance for a single holder of a single contract.
  //   GET /api/v1/token/{contract}/balance/{holder}
  // `decimals` is optional; when supplied the returned `balance` is the human decimal string.
  // Returns { ok, balanceBaseUnits (string), balance (string|null) }.
  async getTokenBalanceOf(contractAddress, holder, decimals = null) {
    if (!contractAddress || !holder) return { ok: false, balanceBaseUnits: '0', balance: null };
    let res;
    try {
      res = await this._hedged(`/api/v1/token/${contractAddress}/balance/${holder}`, { timeoutMs: 5000, hedgeMs: 800, raw: true });
    } catch (e) {
      logger.warn('[QRC20] token balance fetch failed:', e.message);
      return { ok: false, balanceBaseUnits: '0', balance: null };
    }
    if (!res.ok || !res.data) return { ok: false, balanceBaseUnits: '0', balance: null };
    // u64 base units as an exact string — never JSON.parse the number.
    const m = /"balance"\s*:\s*"?(\d+)"?/.exec(res.data);
    const baseUnits = m ? m[1] : '0';
    return {
      ok: true,
      balanceBaseUnits: baseUnits,
      balance: decimals != null ? this._formatBaseUnits(baseUnits, decimals) : null,
    };
  }

  // Scale a human decimal amount string to a u64 base-unit STRING using the token's decimals.
  // Pure string math (no float) so full u64 precision survives — feeds qrc20Transfer's _amt().
  // Throws on a malformed amount or more fractional digits than the token supports.
  toBaseUnits(amountStr, decimals) {
    const d = Number(decimals) || 0;
    let s = String(amountStr == null ? '' : amountStr).trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) throw Object.assign(new Error('Invalid token amount'), { code: 'INVALID_AMOUNT' });
    let [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > d) {
      throw Object.assign(new Error(`Amount has more than ${d} decimal places`), { code: 'AMOUNT_DECIMALS', params: { decimals: d } });
    }
    fracPart = fracPart.padEnd(d, '0');
    const combined = (intPart + fracPart).replace(/^0+(?=\d)/, '');
    return combined === '' ? '0' : combined;
  }

  /**
   * Verify Merkle proof locally using SHA3-256
   * This is the core trustless verification - no network calls needed
   * 
   * CRITICAL: Must match Rust implementation exactly!
   * Rust uses raw bytes, not hex strings for hashing
   */
  /**
   * Shared SMT sibling-fold used by BOTH the account balance proof and the two-level token proof —
   * ONE primitive so a fix to the walk can never drift between the two proof types. Folds `leafHashHex`
   * up `proof` ([{sibling, is_right}, ...]) using `keyHashHex` bits for the expected direction at each
   * level; returns true iff the fold reproduces `root`. MUST stay byte-exact to the Rust
   * verify_proof / verify_raw_proof (SHA3-256 over sibling||current ordered by is_right).
   */
  _smtFold(leafHashHex, keyHashHex, proof, root, sha3_256) {
    // One implementation, in src/crypto/SmtFold.js, so the jest pin guards the shipped code.
    return smtFold(leafHashHex, keyHashHex, proof, root, sha3_256);
  }

  // `extra`: the heartbeat tally and the ban height the answer carries ({ heartbeat_epoch, heartbeat_slots,
  // heartbeat_final_epoch, heartbeat_final_slots, banned_at_height }; zero where it carries none).
  async verifyMerkleProof(address, balance, nonce, proof, expectedRoot, lastClaimedEpoch = 0, isNode = false, extra = {}) {
    try {
      // Account leaf over every field the node hashes (hash_account, QNET_ACCOUNT_V2), in the one shared copy
      // (crypto/SmtFold accountLeafHash): a plain wallet is no contract and carries no code or storage root.
      const leafHash = accountLeafHash(address, {
        balance, nonce, is_contract: false, contract_code_hash: null, storage_root: null,
        heartbeat_epoch: extra.heartbeat_epoch || 0, heartbeat_slots: extra.heartbeat_slots || 0,
        heartbeat_final_epoch: extra.heartbeat_final_epoch || 0, heartbeat_final_slots: extra.heartbeat_final_slots || 0,
        last_claimed_epoch: lastClaimedEpoch, banned_at_height: extra.banned_at_height || 0, is_node: !!isNode,
      }, sha3Hex);
      // Fold the account leaf up to the expected root via the shared SMT primitive.
      return this._smtFold(leafHash, addressKeyHash(address, sha3Hex), proof, expectedRoot, sha3Hex);
    } catch (error) {
      logger.warn('[MERKLE] Proof verification failed:', error.message);
      return false;
    }
  }

  /**
   * V2: verify a two-level trustless QRC-20 balance proof against a QC-committed state_root.
   * Level-2 proves balance:{holder} in storage_root; Level-1 proves the contract account leaf
   * (which commits storage_root) in state_root. Byte-exact to Rust hash_account (SROOT schema) +
   * StorageMerkleTree. Returns true only if BOTH levels verify (and, when supplied, the proof's
   * state_root equals the independently QC-verified expectedStateRoot).
   */
  async verifyTokenBalanceProof(proofData, expectedContract, expectedHolder, expectedStateRoot) {
    try {
      const { sha3_256 } = await import('js-sha3');
      const {
        contract_address, holder, token_balance, storage_root,
        storage_proof, account_proof,
        account_balance, account_nonce,
        contract_code_hash, heartbeat_epoch, heartbeat_slots,
        heartbeat_final_epoch, heartbeat_final_slots, last_claimed_epoch,
        banned_at_height, is_node,
        state_root,
      } = proofData;

      // Identity binding: the folds below verify against the identifiers IN the proof, so reject unless
      // they match what we requested (else a valid proof for another token/holder passes).
      if (expectedContract != null && contract_address !== expectedContract) return false;
      if (expectedHolder != null && holder !== expectedHolder) return false;

      // The proof's own state_root MUST equal the root we independently trust (QC-verified).
      if (expectedStateRoot && state_root !== expectedStateRoot) return false;

      // Bucketed SMT proofs: 40 tree steps + optional in-bucket steps; smtFold
      // enforces the exact bounds and flag rules.
      if (!Array.isArray(storage_proof) || storage_proof.length < 40) return false;
      if (!Array.isArray(account_proof) || account_proof.length < 40) return false;

      // ── Level-2: balance:{holder} ∈ storage_root ──
      const storageKey = 'balance:' + holder;
      const storageKeyHashHex = sha3_256(this.concatBytes(
        Buffer.from('QNET_STORAGE_KEY:', 'utf8'), Buffer.from(storageKey, 'utf8')));
      // QRC-20 removes drained keys, so token_balance "0" ⇒ ABSENT ⇒ empty-leaf default (32 zero bytes).
      const storageLeafHex = String(token_balance) === '0'
        ? '00'.repeat(32)
        : sha3_256(this.concatBytes(Buffer.from('QNET_STORAGE_VAL:', 'utf8'), Buffer.from(String(token_balance), 'utf8')));
      if (!this._smtFold(storageLeafHex, storageKeyHashHex, storage_proof, storage_root, sha3_256)) return false;

      // ── Level-1: contract account leaf (committing storage_root) ∈ state_root ──
      const contractAddrHashHex = sha3_256(this.concatBytes(
        Buffer.from('QNET_ADDR:', 'utf8'), Buffer.from(contract_address, 'utf8')));
      const parts = [
        Buffer.from('QNET_ACCOUNT_V2:', 'utf8'),
        this.uint64ToBytes(account_balance),   // u64 LE (BigInt-safe)
        this.uint64ToBytes(account_nonce),
        Buffer.from(contract_address, 'utf8'),
        Buffer.from([1]),                       // is_contract = true
      ];
      if (contract_code_hash) {
        parts.push(Buffer.from('CODE:', 'utf8'));
        parts.push(Buffer.from(String(contract_code_hash), 'utf8'));
      }
      parts.push(Buffer.from('SROOT:', 'utf8'));
      parts.push(this.hexToBytes(storage_root)); // 32 RAW bytes (not hex text)
      parts.push(Buffer.from('HB:', 'utf8'));
      parts.push(this.uint64ToBytes(heartbeat_epoch || 0));
      const slots = heartbeat_slots || 0;
      parts.push(Buffer.from([slots & 0xff, (slots >> 8) & 0xff])); // u16 LE
      parts.push(this.uint64ToBytes(heartbeat_final_epoch || 0));
      const finalSlots = heartbeat_final_slots || 0;
      parts.push(Buffer.from([finalSlots & 0xff, (finalSlots >> 8) & 0xff])); // u16 LE
      parts.push(Buffer.from('LCE:', 'utf8'));
      parts.push(this.uint64ToBytes(last_claimed_epoch || 0));
      parts.push(Buffer.from('BAN:', 'utf8'));
      parts.push(this.uint64ToBytes(banned_at_height || 0));
      parts.push(Buffer.from('NODE:', 'utf8'));
      parts.push(Buffer.from([is_node ? 1 : 0]));
      const contractLeafHex = sha3_256(this.concatBytes(...parts));
      if (!this._smtFold(contractLeafHex, contractAddrHashHex, account_proof, state_root, sha3_256)) return false;

      return true;
    } catch (error) {
      logger.warn('[MERKLE] Token proof verification failed:', error.message);
      return false;
    }
  }

  // Helper: Concatenate byte arrays
  concatBytes(...arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  // Helper: Convert uint64 to bytes (little-endian)
  uint64ToBytes(value) {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigUint64(0, BigInt(value), true); // little-endian
    return new Uint8Array(buffer);
  }

  // Helper: Bytes to hex string
  bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Helper: Hex string to bytes
  hexToBytes(hex) {
    // Reject malformed hex up front — a bad char/odd length would otherwise
    // make parseInt return NaN, which coerces to 0 and silently corrupts crypto input.
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error('Invalid hex input');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }


  // ── Node records ──────────────────────────────────────────────────────────────────────────────────
  // The app registers no node: payment and registration happen on aiqnet.io or in the browser extension. It keeps
  // the record of the node this wallet runs or monitors, and derives the light node's id itself.

  static NODE_RECORD_KEY = 'qnet_last_activated_node';

  /**
   * Whether `walletAddress` has a registered server node of `nodeType` (with id `nodeId`, when a node names one),
   * as at least two genesis nodes each report it (MOBACT-R3-03). One node's by-wallet listing never links a server
   * node to the wallet: a lagging or compromised node could name one the wallet does not have, and a linked server
   * node takes the Node tab's place of this wallet's own light activation. true; false when two genesis nodes answer
   * authoritatively that there is no such node; null when nothing can be told.
   */
  async confirmServerNode(walletAddress, { nodeType = null, nodeId = null } = {}) {
    if (!walletAddress) return null;
    const verdictOf = (list) => {
      let yes = 0;
      let no = 0;
      for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        if (a.verified === true) {
          const typeOk = !nodeType || !a.node_type || a.node_type === nodeType;
          const idOk = !nodeId || !a.node_id || a.node_id === nodeId;
          if (typeOk && idOk) yes += 1; else no += 1;
        } else if (a.verified === false && a.authoritative !== false) {
          no += 1;
        }
      }
      if (yes >= MIN_GENESIS_AGREEMENT) return true;
      if (no >= MIN_GENESIS_AGREEMENT) return false;
      return null;
    };
    const answers = await this._fromGenesis(async (base) => {
      const ctl = new AbortController();
      const guard = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`${base}/api/v1/verify-activation`, {
          method: 'GET', headers: { 'Content-Type': 'application/json', 'X-QNet-Wallet': walletAddress }, signal: ctl.signal,
        });
        return r.ok ? await r.json() : null;
      } catch (_) {
        return null;
      } finally {
        clearTimeout(guard);
      }
    }, (list) => verdictOf(list) !== null);
    return verdictOf(answers);
  }

  /** Drops a kept server-node record that is not a genesis node's (it proved not to be this wallet's). */
  async forgetServerNodeRecord() {
    try {
      const record = JSON.parse((await AsyncStorage.getItem(WalletManager.NODE_RECORD_KEY)) || 'null');
      if (record && record.nodeType !== 'light' && !record.isGenesis) await AsyncStorage.removeItem(WalletManager.NODE_RECORD_KEY);
    } catch (_) { /* the next check drops it */ }
  }

  /**
   * A small record of this wallet kept at AsyncStorage `key`, sealed under the vault's data key; `purpose`
   * separates record kinds (their AAD). False when the wallet changed meanwhile.
   */
  async putSealedRecord(key, obj, purpose, credential) {
    const gen = this._walletGen;
    const { vault, dekKey } = await this._keyFor(credential);
    if (gen !== this._walletGen) return false;
    await AsyncStorage.setItem(key, JSON.stringify(await sealRecord(dekKey, vault.id, obj, purpose)));
    return true;
  }

  /**
   * The record at `key`: null when there is none, or it belongs to another vault or does not open. Throws when
   * the wallet is locked, so a record that exists is never mistaken for none.
   */
  async getSealedRecord(key, purpose, credential) {
    let rec = null;
    try { rec = JSON.parse((await AsyncStorage.getItem(key)) || 'null'); } catch (_) { rec = null; }
    if (!rec || typeof rec !== 'object') return null;
    const { vault, dekKey } = await this._keyFor(credential);
    if (rec.vault !== vault.id) return null;
    try { return await openRecord(dekKey, rec, purpose); } catch (_) { return null; }
  }

  /** The node this wallet runs or monitors: { nodeType, pseudonym, walletAddress, isGenesis?, bootstrapId? }. */
  async saveNodeRecord({ nodeType, pseudonym = null, walletAddress, isGenesis = false, bootstrapId = null }) {
    if ((nodeType !== 'light' && nodeType !== 'super') || !walletAddress) return;
    const record = { nodeType, walletAddress, timestamp: Date.now() };
    if (pseudonym) record.pseudonym = String(pseudonym);
    if (isGenesis && /^00[1-5]$/.test(String(bootstrapId))) {
      record.isGenesis = true;
      record.bootstrapId = String(bootstrapId);
    }
    await AsyncStorage.setItem(WalletManager.NODE_RECORD_KEY, JSON.stringify(record));
  }

  /** The node record, if it belongs to one of `ownAddresses` (older builds tagged either address). */
  async loadNodeRecord(ownAddresses) {
    let record = null;
    try { record = JSON.parse((await AsyncStorage.getItem(WalletManager.NODE_RECORD_KEY)) || 'null'); } catch (_) {}
    if (!record || typeof record !== 'object' || (record.nodeType !== 'light' && record.nodeType !== 'super')) return null;
    if (!record.walletAddress || !(ownAddresses || []).filter(Boolean).includes(record.walletAddress)) return null;
    const out = { nodeType: record.nodeType, walletAddress: record.walletAddress };
    if (typeof record.pseudonym === 'string' && record.pseudonym) out.pseudonym = record.pseudonym;
    if (record.isGenesis && /^00[1-5]$/.test(String(record.bootstrapId))) {
      out.isGenesis = true;
      out.bootstrapId = String(record.bootstrapId);
    }
    return out;
  }

  // What older builds kept for activation in the app: the sealed code record and its plaintext copies, burn searches,
  // QNet Link burns, pending registrations, the site APK's update check, the network switch, keys named after a code,
  // and the copy of the push token every launch used to take.
  static ACTIVATION_LEFTOVER_KEYS = [
    'qnet_activation_codes', 'qnet_activation_meta_light', 'qnet_activation_meta_super', 'qnet_activation_meta_full',
    'qnet_link_burn', 'qnet_link_burn_superseded', 'qnet_burn_scan', 'qnet_burn_scan_other',
    'qnet_onchain_reg_pending', 'qnet_activation_unconfirmed_at',
    'qnet_update_checked_at', 'qnet_update_dismissed_code', 'qnet_update_cache', 'qnet_testnet',
    'qnet_fcm_token',
  ];
  static ACTIVATION_LEFTOVER_PREFIXES = [
    'qnet_onchain_reg_pending_', 'node_pseudonym_', 'node_next_ping_', 'node_last_ping_', 'blockchain_check_',
    'qnet_dilithium_public_key_', 'qnet_dilithium_secret_key_enc_', 'qnet_dilithium_salt_', 'qnet_identity_pk_QNET-',
  ];

  /**
   * Once per launch, before the node record is read: the leftovers go, and a node record that still names a code or a
   * burn keeps only its node (a genesis node is known by its id; a genesis wallet is linked again by its address).
   * Idempotent and local.
   */
  async cleanupActivationStorage() {
    try {
      const record = JSON.parse((await AsyncStorage.getItem(WalletManager.NODE_RECORD_KEY)) || 'null');
      if (record && typeof record === 'object' && ('code' in record || 'burnTxHash' in record)) {
        const g = /^genesis_node_(00[1-5])$/.exec(typeof record.pseudonym === 'string' ? record.pseudonym : '');
        if (g && !record.bootstrapId) {
          record.isGenesis = true;
          record.bootstrapId = g[1];
        }
        delete record.code;
        delete record.burnTxHash;
        await AsyncStorage.setItem(WalletManager.NODE_RECORD_KEY, JSON.stringify(record));
      }
    } catch (_) { /* an unreadable record is left for the owner check to ignore */ }
    try {
      const all = await AsyncStorage.getAllKeys();
      const doomed = all.filter((k) => WalletManager.ACTIVATION_LEFTOVER_KEYS.includes(k)
        || WalletManager.ACTIVATION_LEFTOVER_PREFIXES.some((p) => k.startsWith(p)));
      if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
    } catch (_) { /* the next launch tries again */ }
  }

  // Generate Light Node pseudonym (matching backend logic)
  generateLightNodePseudonym(walletAddress) {
    // MUST match server: rpc.rs generate_light_node_pseudonym() uses blake3
    // blake3::hash("LIGHT_NODE_PRIVACY_{wallet}") → first 16 hex chars (64-bit)
    const { blake3 } = require('@noble/hashes/blake3.js');
    const input = `LIGHT_NODE_PRIVACY_${walletAddress}`;
    const hashBytes = blake3(Buffer.from(input, 'utf8'));
    // First 8 bytes → 16 hex chars (matches Rust: &pseudonym_hash.to_hex()[..16])
    const hexHash = Array.from(hashBytes.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    // Region-independent: server pins the "mobile" segment (no QNET_REGION in id derivation)
    return `light_mobile_${hexHash}`;
  }

  // The id a super node of this wallet has on the chain, whichever server runs it: super_node_ + the first 16 hex of
  // blake3("SUPER_NODE_PRIVACY_" + wallet), the node's generate_super_node_pseudonym (a domain of its own, so a
  // wallet's super and light ids never collide).
  generateSuperNodePseudonym(walletAddress) {
    const { blake3 } = require('@noble/hashes/blake3.js');
    const hashBytes = blake3(Buffer.from(`SUPER_NODE_PRIVACY_${walletAddress}`, 'utf8'));
    return `super_node_${Buffer.from(hashBytes.slice(0, 8)).toString('hex')}`;
  }

  // The open wallet's ML-DSA-65 key for one node message: its address, node id, public key (hex) and `sign`, which
  // signs only preimages built from these values. The secret key lives as long as the call.
  async _nodeSigner(credential) {
    const wd = await this.loadWallet(credential);
    const qk = wd && wd.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey || !wd.qnetAddress) throw new Error('No ML-DSA-65 QNet key in wallet');
    const sk = new Uint8Array(qk.privateKey);
    const skHex = Buffer.from(sk).toString('hex');
    sk.fill(0);
    if (Array.isArray(qk.privateKey) || qk.privateKey instanceof Uint8Array) qk.privateKey.fill(0);
    const { signDetached } = require('../crypto/DilithiumCrypto');
    return {
      wallet: wd.qnetAddress,
      nodeId: lightNodeId(wd.qnetAddress),
      publicKey: Buffer.from(new Uint8Array(qk.publicKey)).toString('hex'),
      sign: (preimage) => signDetached(preimage, skHex),
    };
  }

  /**
   * The wallet key's signature of this wallet's node status request (light-node-messages section 7), with the key
   * itself: a node that never held a binding knows the key only from the request.
   */
  async signNodeStatus(credential, nodeId, ts) {
    const k = await this._nodeSigner(credential);
    if (k.nodeId !== nodeId) throw new Error('Not this wallet\'s node');
    return { signer: 'wallet', sig: await k.sign(statusPreimage(nodeId, ts)), identityPublicKey: k.publicKey };
  }

  /**
   * The wallet key's unbind of this wallet's light node (light-node-messages, the wallet form of /unbind): it withdraws
   * the binding `seq` the node's signed status names, from any device that holds the wallet, whichever device the binding
   * is on. The signature is checked against the key before it leaves. { sig, identityPublicKey } (hex).
   */
  async signNodeUnbind(credential, nodeId, seq, ts) {
    const k = await this._nodeSigner(credential);
    if (k.nodeId !== nodeId) throw new Error('Not this wallet\'s node');
    const preimage = walletUnbindPreimage(nodeId, seq, ts);
    const sig = await k.sign(preimage);
    const { verifyDilithium } = require('../crypto/DilithiumCrypto');
    if (!(await verifyDilithium(preimage, sig, k.publicKey))) throw new Error('The unbind signature does not verify');
    return { sig, identityPublicKey: k.publicKey };
  }

  /**
   * A binding of this wallet's light node to this device (light-node-messages section 4): a new ping key, and the
   * delegation and attach signed by the wallet key for `seq`, `ts` and the push target the node will wake this device
   * through. Nothing is sent from here. `keep()` stores the ping key (Keychain, after first unlock, this device only)
   * once the node took the binding; `wipe()` drops it otherwise.
   */
  async prepareLightNodeBinding(credential, { seq, ts, pushTarget }) {
    return this._bindingWith(await this._nodeSigner(credential), { seq, ts, pushTarget });
  }

  /**
   * The QNet Link sheet's consent (qnet-link-v1 section 14.8): the wallet key signs its consent to the registration
   * with `burnTx` at `ts` = T, over the proof it computes itself. With a `pushTarget` it also signs the binding of this
   * device with seq = ts = T (see prepareLightNodeBinding). With `burner`, a burn made from this wallet's own Solana
   * address, that address's key signs the burn's owner bind for the same registration (signOwnBurnBind); the app signs
   * no other burner's bind. { nodeId, wallet, identityPublicKey, proof, consentSig, ownerSig | null, binding | null }.
   */
  async prepareLinkConsent(credential, { burnTx, ts, pushTarget = null, burner = null }) {
    const k = await this._nodeSigner(credential);
    const proof = registrationProof(burnTx, k.nodeId, k.wallet);
    const consentSig = await k.sign(consentPreimage(k.nodeId, k.wallet, proof, ts));
    const ownerSig = burner === null ? null : await this.signOwnBurnBind(credential, {
      nodeId: k.nodeId, wallet: k.wallet, proof, ts, publicKey: k.publicKey, burnTx, burner,
    });
    const binding = pushTarget === null ? null : await this._bindingWith(k, { seq: ts, ts, pushTarget });
    return { nodeId: k.nodeId, wallet: k.wallet, identityPublicKey: k.publicKey, proof, consentSig, ownerSig, binding };
  }

  /**
   * The owner bind of a light burn this wallet made from its own Solana address `burner` (by the extension or an older
   * app), for the registration of its own light node (light-node-messages section 4, the v1 form, built by the shared
   * ownerBindPreimage): the wallet's Solana key, the one its recovery phrase makes on m/44'/501'/0'/0', signs its node,
   * the wallet, the proof, the consent's T, the SHA3-256 of its own ML-DSA-65 key and the burn. Only for the open
   * wallet's own address and its own node; checked against the key before it leaves. The key is decrypted for this one
   * signature and wiped. 128 hex.
   */
  async signOwnBurnBind(credential, { nodeId, wallet, proof, ts, publicKey, burnTx, burner }) {
    const wd = await this.loadWallet(credential);
    const qk = wd && wd.qnetKeypair;
    if (qk && (Array.isArray(qk.privateKey) || qk.privateKey instanceof Uint8Array)) qk.privateKey.fill(0);
    const own = wd && (wd.solanaAddress || wd.address);
    if (!wd || wd.qnetAddress !== wallet || lightNodeId(wallet) !== nodeId) throw new Error('Not this wallet\'s node');
    if (!own || own !== burner) throw new Error('Not this wallet\'s Solana address');
    const stored = wd.secretKey;
    if (!stored || stored.length !== 64) throw new Error('No Solana key in wallet');
    const seed = Uint8Array.from(stored).subarray(0, 32);
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      if (base58Encode(pair.publicKey) !== own) throw new Error('The wallet key does not match its address');
      const message = utf8ToBytes(ownerBindPreimage(nodeId, wallet, proof, ts, publicKey, burnTx));
      const sig = nacl.sign.detached(message, pair.secretKey);
      if (!nacl.sign.detached.verify(message, sig, pair.publicKey)) throw new Error('The owner bind does not verify');
      return Buffer.from(sig).toString('hex');
    } finally {
      seed.fill(0);
      pair.secretKey.fill(0);
      if (Array.isArray(stored) || stored instanceof Uint8Array) stored.fill(0);
    }
  }

  /**
   * The QNet Link sheet's reservation (qnet-link-v1 section 14, `reserve`): the wallet key signs that aiqnet.io may
   * prepare this wallet's light node with the one-time payment address `burner`, at `time` = T, as a site record for the
   * site's origin (crypto/OffchainMessage signSiteRecord; EXPLORER_API, the origin the QNet Link relay has too). The key
   * is decrypted for this one signature and wiped. { address, pk, sig } (EON, b64url, b64url).
   */
  async signNodeReservation(credential, { burner, time }) {
    const wd = await this.loadWallet(credential);
    const qk = wd && wd.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey || !wd.qnetAddress) throw new Error('No ML-DSA-65 QNet key in wallet');
    const sk = new Uint8Array(qk.privateKey);
    const pk = new Uint8Array(qk.publicKey);
    try {
      const message = nodeReservationMessage({
        wallet: wd.qnetAddress, nodeType: 'light', way: 'payment', burner, time, cluster: SOLANA_CLUSTER,
      });
      const signed = signSiteRecord(EXPLORER_API, message, sk, pk);
      if (signed.address !== wd.qnetAddress) throw new Error('The wallet key does not match its address');
      return { address: signed.address, pk: b64url(pk), sig: b64url(signed.signature) };
    } finally {
      sk.fill(0);
      if (Array.isArray(qk.privateKey) || qk.privateKey instanceof Uint8Array) qk.privateKey.fill(0);
    }
  }

  async _bindingWith(k, { seq, ts, pushTarget }) {
    const { generateRawDilithiumKeypair } = require('../crypto/DilithiumCrypto');
    const ping = await generateRawDilithiumKeypair(`qnet_ping_key_v2:${this.bytesToHex(randomBytes(32))}`);
    let pingSk = ping.secretKey;
    const delegation = await k.sign(delegationPreimage(ping.publicKey, k.nodeId, seq));
    const attachSig = await k.sign(attachPreimage(k.nodeId, ping.publicKey, pushTarget, seq, ts));
    const gen = this._walletGen;
    return {
      nodeId: k.nodeId,
      wallet: k.wallet,
      identityPublicKey: k.publicKey,
      pingPublicKey: ping.publicKey,
      delegation,
      attachSig,
      keep: async () => {
        if (!pingSk || gen !== this._walletGen) throw new Error('The binding is no longer this wallet\'s');
        await Keychain.setGenericPassword('ping', pingSk, {
          service: `qnet_ping_sk_${k.nodeId}`,
          accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
        pingSk = null;
      },
      wipe: () => { pingSk = null; },
    };
  }

  /**
   * A node's refusal of a move of the node balance, as a coded error: NO_REWARDS (nothing to move), MIN_CLAIM,
   * NOT_REGISTERED, CLAIM_BUSY (a move of this node is running), RATE_LIMITED or CLAIM_REFUSED. The node's own words
   * never reach the screen (they are English and speak the node's language); the screen says the code's text, and the
   * words go to the log only.
   */
  static claimRefusal(answer, httpStatus = null) {
    const words = String((answer && (answer.error || answer.message)) || '');
    const code = /no claimable|no pending/i.test(words) ? 'NO_REWARDS'
      : /minimum claim/i.test(words) ? 'MIN_CLAIM'
        : /not registered/i.test(words) ? 'NOT_REGISTERED'
          : /already in progress/i.test(words) ? 'CLAIM_BUSY'
            : httpStatus === 429 || /rate limit|too many/i.test(words) ? 'RATE_LIMITED' : 'CLAIM_REFUSED';
    if (words) logger.warn('[claimRewards] refused:', code, words.slice(0, 200));
    return Object.assign(new Error('The network refused the move of the node balance'), { code });
  }

  // Move a node's balance (the network's per-epoch accounting for it) into the wallet with one transaction the wallet
  // key signs. Works for every node type: light, super, genesis. The node checks the balance; the wallet checks the batch.
  async claimRewards(nodeType, walletAddress, password, serverPendingRewards = null, actualNodeId = null) {
    try {
      // The node balance as the caller read it (nanoQNC), when it did.
      if (serverPendingRewards !== null && serverPendingRewards <= 0) {
        return { success: false, message: 'The node balance is empty', code: 'NO_REWARDS' };
      }
      if (serverPendingRewards !== null && serverPendingRewards < NANO_PER_QNC) {
        return { success: false, message: 'The smallest move is 1 QNC', code: 'MIN_CLAIM' };
      }

      let nodeId = actualNodeId;
      if (!nodeId) {
        if (nodeType === 'light') nodeId = this.generateLightNodePseudonym(walletAddress);
        else {
          throw Object.assign(new Error('The node id of this node is not known yet — refresh the Node tab and try again'),
            { code: 'NODE_ID_UNKNOWN' });
        }
      }
      
      // Load wallet for signing
      const walletData = await this.loadWallet(password);
      if (!walletData) {
        throw new Error('Failed to load wallet for signing');
      }
      
      // PURE DILITHIUM (F0.2): the reward claim is authorised ONLY by the ML-DSA-65 signature below over
      // "{chain_tag}claim_rewards:{node_id}:{wallet_address}" (the node also matches the on-chain wallet +
      // re-verifies the merkle proof). Ed25519 is Solana-only and no longer sent on this QNet path.
      // Chain-bound like every other preimage: mirror of rpc.rs handle_claim_rewards.
      const message = `${QNET_CHAIN_TAG}claim_rewards:${nodeId}:${walletAddress}`;

      // ML-DSA-65 signature — quantum-safe proof of node ownership (NIST FIPS 204)
      let dilithiumSignature = null;
      let dilithiumPublicKey = null;
      try {
        const { signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
        if (isDilithiumAvailable()) {
          const dilithiumKeys = await this._walletDilithiumKeys(password);
          dilithiumSignature = await signWithDilithium(message, dilithiumKeys.secretKey, dilithiumKeys.publicKey, nodeId);
          dilithiumPublicKey = dilithiumKeys.publicKey;
        }
      } catch (dilithiumErr) {
        // Dilithium signing failed — server v5.0+ will reject the claim without it.
        // The error from the server will surface to the user via the normal error path.
        logger.warn('[claimRewards] Dilithium signing failed (server will reject):', dilithiumErr.message);
      }
      
      // Submit claim (hedged POST — timeout-bounded across two nodes).
      const claimRes = await this._hedged('/api/v1/rewards/claim', {
        method: 'POST', timeoutMs: 8000, hedgeMs: 1200,
        body: {
          node_id: nodeId,
          wallet_address: walletAddress,
          ...(dilithiumSignature && { dilithium_signature: dilithiumSignature }),
          ...(dilithiumPublicKey && { dilithium_public_key: dilithiumPublicKey }),
        },
      });
      let claimResult = claimRes.data || {};
      if (!claimRes.ok) throw WalletManager.claimRefusal(claimResult, claimRes.status);

      // Two-step claim: step 1 QUOTES the batch, we sign those exact bytes, step 2 submits them.
      // On-chain apply credits only what this wallet's key authorized, so no relayer can aim a claim
      // at us. The node still picks the batch, so refuse to sign a quote that does not cover the
      // independently-polled pending total — a truncated batch would strand the epochs it omits.
      if (claimResult.needs_signature) {
        if (!claimResult.claims_data || !claimResult.sign_message) {
          throw new Error('Node returned an incomplete claim quote');
        }
        // Check the batch SHAPE, not its total. Epochs a node cannot serve make an honest quote
        // legitimately short, so comparing sums rejects honest nodes; what actually strands rewards is
        // a batch that SKIPS epochs, because the on-chain watermark is monotonic. Requiring strictly
        // ascending epochs starting just above the wallet's watermark makes a skip unsignable.
        let claimsParsed;
        try {
          claimsParsed = JSON.parse(claimResult.claims_data).claims;
        } catch (e) {
          throw new Error('Node returned a malformed claim quote');
        }
        if (!Array.isArray(claimsParsed) || claimsParsed.length === 0) {
          throw new Error('Node returned an empty claim quote');
        }
        const watermark = Number(claimResult.last_claimed_epoch ?? -1);
        if (!Number.isInteger(watermark) || watermark < 0) {
          throw new Error('Node did not report the claim watermark');
        }
        let prevEpoch = watermark;
        for (const entry of claimsParsed) {
          if (!Number.isInteger(entry.epoch) || entry.epoch <= prevEpoch) {
            throw new Error('Node quoted a non-ascending claim batch — retry on another node');
          }
          prevEpoch = entry.epoch;
        }
        // The head is what a malicious quote would drop, so verify it against a DIFFERENT node —
        // excluding the quoting one, which would otherwise be the top-ranked responder here too and
        // simply confirm its own answer. Skipping the first earned epoch would burn it behind the
        // monotonic watermark once this batch lands.
        const others = this.getTrustedNodes(GENESIS_NODES.length).filter((b) => b !== claimRes.base).slice(0, 2);
        const headRes = others.length
          ? await this._hedged(`/api/v1/rewards/pending/${encodeURIComponent(nodeId)}`,
                               { timeoutMs: 6000, hedgeMs: 1200, nodes: others })
          : { ok: false };
        const expectedHead = headRes.ok ? headRes.data?.first_unclaimed_epoch : null;
        if (!Number.isInteger(expectedHead)) {
          // Fail CLOSED: unverified head means the quote's starting epoch is unchecked, and signing it
          // is irreversible (the on-chain watermark only moves forward).
          throw new Error('Could not verify the claim head against a second node — retry');
        }
        if (claimsParsed[0].epoch !== expectedHead) {
          throw new Error(`Node quoted a batch starting at epoch ${claimsParsed[0].epoch}, expected ${expectedHead} — retry on another node`);
        }
        // nanoQNC exceeds 2^53, so the total is carried as a decimal string and compared as BigInt.
        const quotedNano = BigInt(claimResult.amount_nano ?? '0');
        if (quotedNano <= 0n) {
          throw new Error('Node quoted a zero-value claim');
        }
        // A move takes at least 1 QNC; less only as a part the quote capped (stopped_at_epoch: more epochs remain), so
        // the whole balance can always move. Anything else is refused before signing, never signed and then reported
        // as not done (a QNet Link answer cannot carry it).
        const capped = claimResult.stopped_at_epoch !== null && claimResult.stopped_at_epoch !== undefined;
        if (!capped && quotedNano < BigInt(NANO_PER_QNC)) {
          throw Object.assign(new Error('The smallest move is 1 QNC'), { code: 'MIN_CLAIM' });
        }
        // NEVER sign a server-supplied string with the wallet key. This used to sign
        // `claimResult.sign_message` verbatim with the SAME ML-DSA-65 key that signs
        // `q{chain}|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}`, and nothing anywhere
        // rebuilt or checked the `qnet_claim_v1` prefix — so the prefix separated nothing and any
        // node in the hedged pool could return a transfer-shaped string and drain the wallet, while
        // the user saw only "Failed to submit signed claim".
        //
        // The preimage is fully derivable here: both inputs are values this client already holds and
        // already sends back in the same POST, so the node's copy is pure convenience and is now
        // treated as untrusted. Mirror of BlockchainNode::claim_sign_message.
        const { sha3_256 } = require('js-sha3');
        const claimTs = claimResult.claim_timestamp;
        if (!Number.isInteger(claimTs) || claimTs <= 0) {
          throw new Error('Node returned no claim timestamp — refusing to sign');
        }
        const signMessage =
          `${QNET_CHAIN_TAG}qnet_claim_v1:${walletAddress}:${claimTs}:${sha3_256(claimResult.claims_data)}`;
        if (claimResult.sign_message && claimResult.sign_message !== signMessage) {
          // Not fatal by itself — the locally built message is what gets signed either way — but a
          // mismatch means the node asked for something else, and that is worth refusing loudly.
          throw new Error('Node asked the wallet to sign a different message — refusing');
        }
        const { signWithDilithium } = require('../crypto/DilithiumCrypto');
        const dilithiumKeys = await this._walletDilithiumKeys(password);
        const claimsSignature = await signWithDilithium(
          signMessage, dilithiumKeys.secretKey, dilithiumKeys.publicKey, nodeId);
        const submitRes = await this._submitClaim({
          node_id: nodeId,
          wallet_address: walletAddress,
          dilithium_signature: dilithiumSignature,
          dilithium_public_key: dilithiumKeys.publicKey,
          claims_data: claimResult.claims_data,
          claims_signature: claimsSignature,
          // Inside the signed message and reused as the TX timestamp, so the payload cannot be
          // re-stamped into a fresh hash and replayed.
          claim_timestamp: claimResult.claim_timestamp,
        });
        const submitted = submitRes.data || {};
        if (!submitRes.ok || !submitted.success) throw WalletManager.claimRefusal(submitted, submitRes.status);
        // The quote's stop point survives the submit, so the UI can name the epoch the batch stopped at.
        claimResult = { ...submitted, epochs_claimed: claimResult.epochs_claimed, amount_nano: quotedNano.toString(),
                        stopped_at_epoch: claimResult.stopped_at_epoch, stopped_reason: claimResult.stopped_reason };
      }

      if (!claimResult.success) throw WalletManager.claimRefusal(claimResult);

      // Server returns amount_qnc (QNC) + epochs_claimed. The claim is SUBMITTED here and credited on
      // inclusion (the per-proof merkle claim finalizes within ~1 block); balance reconciles on the next
      // status poll. Previously read reward.total_qnc/amount which the handler never returns → always 0.
      const claimedAmount = claimResult.amount_qnc ?? claimResult.amount ?? 0;
      const epochsClaimed = claimResult.epochs_claimed ?? 0;
      
      // Update local storage with claim time
      const storedRewardsStr = await AsyncStorage.getItem('qnet_node_rewards');
      let storedRewards = {};
      if (storedRewardsStr) {
        try {
          storedRewards = JSON.parse(storedRewardsStr);
        } catch (e) {
          // console.error('Error parsing stored rewards:', e);
        }
      }
      
      storedRewards.lastClaim = Date.now();
      storedRewards.totalClaimed = (storedRewards.totalClaimed || 0) + claimedAmount;
      await AsyncStorage.setItem('qnet_node_rewards', JSON.stringify(storedRewards));
      
      return {
        success: true,
        amount: claimedAmount,
        // The quoted batch in nanoQNC as a decimal string (above 2^53), when the node quoted one.
        amountNano: typeof claimResult.amount_nano === 'string' ? claimResult.amount_nano : null,
        epochsClaimed,
        stoppedAtEpoch: claimResult.stopped_at_epoch ?? null, // the epoch the quote stopped at, if it did
        stoppedReason: claimResult.stopped_reason ?? null,
        pending: true, // submitted; credited on inclusion — balance updates on the next status poll
        timestamp: Date.now(),
        nextClaim: claimResult.next_claim_time || (Date.now() + 24 * 60 * 60 * 1000),
        txHash: claimResult.tx_hash
      };
    } catch (error) {
      // console.error('Error claiming rewards:', error);
      throw error;
    }
  }

  // Universal send transaction function (routes to appropriate network).
  // Native QNC → sendQNC. QRC-20 tokens are sent via qrc20Transfer directly from the UI
  // (contract address + per-token decimals are threaded through the send modal), and SOL and
  // Solana tokens through services/SolanaSend with signSolanaMessage, so this function only
  // handles the native asset; any other symbol here is a caller bug.
  async sendTransaction(fromAddress, toAddress, amount, tokenSymbol, password, { choice = null } = {}) {
    try {
      // Route to appropriate network handler
      if (tokenSymbol === 'QNC') {
        return await this.sendQNC(toAddress, amount, password, { choice });
      } else {
        // QRC-20 tokens do not reach here — the UI calls qrc20Transfer(contract, ...) directly.
        throw new Error(`sendTransaction is for native QNC only; use qrc20Transfer for token ${tokenSymbol}`);
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: error.code || (error.name === 'TooManyPendingError' ? 'TOO_MANY_PENDING' : undefined),
        pending: error.pending || undefined,
      };
    }
  }

  // Send QNC tokens to another address. `amountNano` (a safe integer) is the exact amount when the caller has
  // it (the in-app browser's confirmed send); `expectNonce` is the nonce its confirmation showed; `choice` what
  // the user chose about this wallet's unsettled transactions (replace one, or send in addition).
  async sendQNC(toAddress, amount, password, { amountNano = null, expectNonce = null, choice = null, oneInFlight = false } = {}) {
    try {
      // EON (45 chars, "eon" marker at offset 19, 8-char SHA3 checksum) in the lowercase form the chain uses; a
      // mistyped EON address, and 64 hex that no key can control, are refused before anything is signed (MOBNET-R4-01).
      if (!toAddress) {
        throw new Error('Recipient address is required');
      }
      const to = WalletManager.recipientAddress(toAddress);
      if (amountNano !== null && (!Number.isSafeInteger(amountNano) || amountNano <= 0)) {
        throw Object.assign(new Error('Amount must be a valid positive number'), { code: 'INVALID_AMOUNT' });
      }
      if (amountNano === null && (!Number.isFinite(amount) || amount <= 0)) {
        throw Object.assign(new Error('Amount must be a valid positive number'), { code: 'INVALID_AMOUNT' });
      }

      // Load wallet for signing
      const walletData = await this.loadWallet(password);
      if (!walletData || !walletData.secretKey) {
        throw new Error('Failed to load wallet for signing');
      }

      // Get sender address (use QNet EON address from wallet)
      const fromAddress = walletData.qnetAddress || walletData.address;
      if (!fromAddress) {
        throw new Error('Wallet has no QNet address');
      }

      // PURE DILITHIUM (F0.1): the QNet wallet key is ML-DSA-65 (pk 1952B / sk 4032B). Ed25519 is a
      // Solana-only credential and is NOT used to sign QNet TX. Load the Dilithium wallet key.
      const qk = walletData.qnetKeypair;
      if (!qk || !qk.privateKey || !qk.publicKey) {
        throw new Error('No ML-DSA-65 QNet key in wallet — re-create/import to derive the pure-Dilithium key');
      }
      const dilPkHex = Buffer.from(new Uint8Array(qk.publicKey)).toString('hex');
      const dilSkHex = Buffer.from(new Uint8Array(qk.privateKey)).toString('hex');

      // v2.101: Math.round() to avoid float precision loss (QNC → nano, 9 decimals).
      const amountSmallest = amountNano !== null ? amountNano : Math.round(amount * 1_000_000_000);
      if (!Number.isSafeInteger(amountSmallest)) {
        throw new Error('Amount too large or imprecise'); // beyond 2^53 nano — would lose precision
      }
      const gasPrice = GAS_PRICE; // fee = (10 + 10/2) * 10_000 = 150_000 nanoQNC: ML-DSA costs +50%
      const gasLimit = TRANSFER_GAS_LIMIT;

      const { signDetached } = require('../crypto/DilithiumCrypto');

      // The canonical message MUST byte-match the node's build_canonical_verify_message Transfer arm:
      // "q{chain}|transfer:from:to:amount:nonce:gas_price:gas_limit". FIX-5: the RAW detached ML-DSA-65
      // signature as hex (3309 B → 6618 hex chars) and, until the chain has committed it, the RAW pubkey
      // as hex (1952 B → 3904 hex chars); the node rehydrates an elided key from state (pk-ELISION). The
      // key is outside the signed message, so a resend that attaches it is the same transaction.
      const sinceMs = Date.now();
      const sent = await this._signAndSubmit(fromAddress, async (txNonce) => {
        const fields = { from: fromAddress, to, amountNano: amountSmallest, nonce: txNonce, gasPrice, gasLimit };
        const message = transferPreimage(fromAddress, to, amountSmallest, txNonce, gasPrice, gasLimit);
        const signature = await signDetached(message, dilSkHex);
        // Every integer here is a safe one, so the parsed body writes back as the same bytes.
        const body = JSON.parse(transferRequestJson(fields, signature, WalletManager._pkElidable(fromAddress) ? null : dilPkHex));
        return { path: TX_ROUTES.transfer.path, body, pk: dilPkHex };
      }, {
        kind: 'transfer', to, amount, amountNano: amountSmallest, sinceMs,
        spend: { qncNano: String(BigInt(amountSmallest) + BigInt(feeNano(gasPrice, gasLimit))) },
      }, { expectNonce, choice, oneInFlight });

      // Only a transaction hash from a node is "sent". Anything else — no answer, or a refusal from a node
      // that may still hold the signed bytes — is unknown until the chain settles the nonce.
      if (!sent.accepted) {
        return { success: false, error: sent.error || null, ...sent.unknown };
      }
      return {
        success: true, txHash: sent.data.tx_hash, nonce: sent.nonce, replaced: sent.replaced,
        from: fromAddress, to, amount, amountNano: amountSmallest, timestamp: Date.now(),
      };
    } catch (error) {
      logger.warn('[WalletManager] Send QNC error:', error.message || error);
      throw error;
    }
  }

  // ===========================================================================
  // QRC-20 SDK — client-side ContractCall/ContractDeploy convenience wrappers
  // ===========================================================================
  // Same wallet-load, ML-DSA-65 signer, local-nonce and hedged-submit path as
  // sendQNC. The node builds tx.data server-side from the request fields, so the
  // signature MUST bind the EXACT byte string it will reproduce:
  //   ContractCall   canonical: q{chain}|contract_call:{from}:{sha3_256_hex(dataStr)}:{nonce}:{gas_price}:{gas_limit}
  //                  dataStr = serde_json::to_string(json!({"contract","method","args"})).
  //                  serde_json here has preserve_order OFF (Map = BTreeMap), so the node
  //                  emits keys ALPHABETICALLY: `{"args":..,"contract":..,"method":..}`.
  //                  The client MUST hash that exact ordering (not JS insertion order).
  //                  Args are strings (addresses, decimal amounts, NFT token_ids) + the
  //                  occasional small integer; JSON.stringify then matches serde's compact
  //                  form byte-for-byte. QRC-20 amounts + QRC-721 token_ids are passed as
  //                  STRINGS (node reads string-or-number) so full u64 values survive exactly
  //                  — a JSON number would truncate above 2^53 and bake the loss into the
  //                  signed digest (see qrc20*/_amt and the nft* wrappers).

  // Load the ML-DSA-65 wallet key as {from, dilPkHex, dilSkHex} — mirrors sendQNC.
  async _loadContractSigner(password) {
    const walletData = await this.loadWallet(password);
    if (!walletData) throw new Error('Failed to load wallet for signing');
    const from = walletData.qnetAddress || walletData.address;
    if (!from) throw new Error('Wallet has no QNet address');
    const qk = walletData.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey) {
      throw new Error('No ML-DSA-65 QNet key in wallet — re-create/import to derive the pure-Dilithium key');
    }
    return {
      from,
      dilPkHex: Buffer.from(new Uint8Array(qk.publicKey)).toString('hex'),
      dilSkHex: Buffer.from(new Uint8Array(qk.privateKey)).toString('hex'),
    };
  }

  // Build + sign + submit a ContractCall. `args` is the method's positional argument
  // array (see the qrc20* wrappers for each method's shape). Returns the node's
  // { success, tx_hash, ... } JSON; anything short of an accepted hash throws with `err.unknown`.
  // `opts.expectNonce`: the nonce a confirmation showed (NONCE_CHANGED otherwise); `opts.choice` as in resolveNonce;
  // `opts.oneInFlight` as in _signAndSubmit.
  async buildContractCall(contractAddress, method, args, password, opts = {}) {
    if (!contractAddress || !method) throw new Error('contractAddress and method are required');
    const argList = Array.isArray(args) ? args : [];
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);

    // Byte-exact match to the node's json! serialization: serde_json (preserve_order OFF)
    // sorts object keys, so the keys MUST be alphabetical — args, contract, method.
    const dataStr = contractCallData(contractAddress, method, argList);
    const gasPrice = opts.gasPrice != null ? opts.gasPrice : GAS_PRICE;
    // Apply refuses a call whose intrinsic gas exceeds its limit; the intrinsic gas is the exact default.
    const gasLimit = opts.gasLimit != null ? opts.gasLimit : contractCallIntrinsicGas(dataStr);

    const { signDetached } = require('../crypto/DilithiumCrypto');

    // The signature covers the gas, so no relay can raise it. pk-ELISION as in sendQNC.
    const reserveNano = feeNano(Number(gasPrice), Number(gasLimit)) + (method === 'transfer' ? STORAGE_DEPOSIT_NANO : 0);
    const sent = await this._signAndSubmit(from, async (txNonce) => {
      const fields = { from, contract: contractAddress, method, args: argList, nonce: txNonce, gasPrice, gasLimit };
      const message = contractCallPreimage(from, dataStr, txNonce, gasPrice, gasLimit);
      const signature = await signDetached(message, dilSkHex); // FIX-5: raw detached hex
      const body = JSON.parse(contractCallRequestJson(fields, signature, WalletManager._pkElidable(from) ? null : dilPkHex));
      return { path: TX_ROUTES.call.path, body, pk: dilPkHex };
    }, {
      kind: 'call', to: contractAddress, method,
      // A token transfer names its recipient and amount, so an unanswered one can be told from another call to
      // the same contract at the same nonce (MOBNET-R2-02).
      ...(method === 'transfer' && argList.length === 2 ? { recipient: String(argList[0]), amountBase: String(argList[1]) } : {}),
      // Its most fee, and for a token transfer the deposit a new holder costs, reserved until it settles: whether the
      // recipient holds the token when it applies is not known now (MOB-BR-R3-02).
      reserveNano,
      spend: { qncNano: String(reserveNano), ...WalletManager._tokenSpendOf(from, contractAddress, method, argList) },
    }, {
      expectNonce: opts.expectNonce != null ? opts.expectNonce : null, choice: opts.choice || null, oneInFlight: opts.oneInFlight === true,
    });
    return WalletManager._acceptedOrUnknown(sent, 'call');
  }

  /**
   * A call of a WASM contract (crypto/TxBuilders buildContractCall): `args` its input as hex (null for none), the gas
   * limit the intrinsic gas plus the default fuel unless `gasLimit` is given. It carries no QNC. Returns and throws like
   * buildContractCall; `opts` { expectNonce, choice } as there.
   */
  async callWasmContract({ contract, method, args = null, gasLimit = null }, password, opts = {}) {
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);
    const { signDetached } = require('../crypto/DilithiumCrypto');
    // The most fee does not depend on the nonce: reserved while the call is unsettled (MOB-BR-R3-02).
    const reserveNano = Number(buildWasmCall({ from, contract, method, args, nonce: 1, gasLimit }).maxFeeNano);
    const sent = await this._signAndSubmit(from, async (txNonce) => {
      const tx = buildWasmCall({ from, contract, method, args, nonce: txNonce, gasLimit });
      const signature = await signDetached(tx.preimage, dilSkHex);
      const body = JSON.parse(contractCallRequestJson(tx, signature, WalletManager._pkElidable(from) ? null : dilPkHex));
      return { path: tx.path, body, pk: dilPkHex };
    }, {
      kind: 'call', to: contract, method, reserveNano,
      // What a contract's code does with this wallet's tokens is not known here.
      spend: { qncNano: String(reserveNano), tokenUnknown: true },
    }, {
      expectNonce: opts.expectNonce != null ? opts.expectNonce : null, choice: opts.choice || null, oneInFlight: opts.oneInFlight === true,
    });
    return WalletManager._acceptedOrUnknown(sent, 'call');
  }

  /**
   * The tokens a built-in token call of `from` moves out of its own balance: { tokens: { contract: amount } } for a
   * transfer or a burn, and a transferFrom out of `from`; {} for one that moves none of it (approve, mint, a
   * transferFrom of another holder's tokens); { tokenUnknown: true } for any other method.
   */
  static _tokenSpendOf(from, contract, method, args) {
    const amountAt = (i) => (Array.isArray(args) && /^\d{1,20}$/.test(String(args[i])) ? String(args[i]) : null);
    const out = (amount) => (amount === null ? { tokenUnknown: true } : { tokens: { [contract]: amount } });
    if (method === 'transfer' && args.length === 2) return out(amountAt(1));
    if (method === 'burn' && args.length === 1) return out(amountAt(0));
    if (method === 'transferFrom' && args.length === 3) return String(args[0]) === String(from) ? out(amountAt(2)) : {};
    if ((method === 'approve' || method === 'mint') && args.length === 2) return {};
    return { tokenUnknown: true };
  }

  // The node's reply for an accepted transaction; otherwise a throw carrying the unknown outcome, which
  // the caller reports and resolves by nonce like an unanswered send. An accepted reply carries the nonce it was
  // signed at as a non-enumerable `submitNonce` (not part of what a site is handed), so the screen can settle it by
  // (from, nonce) when the copy that lands has another hash or the nonce goes to another transaction (MOBNET-R3-03).
  static _acceptedOrUnknown(sent, what) {
    if (sent.accepted) {
      const data = { ...(sent.data || {}) };
      Object.defineProperty(data, 'submitNonce', { value: sent.nonce, enumerable: false });
      return data;
    }
    const err = new Error(sent.error
      ? `A node did not accept this ${what}: ${sent.error}`
      : `The network did not answer — this ${what} may still be on its way`);
    err.unknown = sent.unknown;
    throw err;
  }

  // QRC-20 convenience wrappers — amounts are raw token base-units (u64), NOT decimal
  // token amounts; scale by 10**decimals in the UI before calling. Args mirror the
  // node's apply arms: transfer[to,amt] approve[spender,amt] transferFrom[from,to,amt]
  // mint[to,amt] burn[amt].
  //
  // Amounts are passed as DECIMAL STRINGS (not JSON numbers): the node's amount reader
  // now accepts string-or-number, and a string carries the full u64 range exactly. A JSON
  // number would silently lose precision above 2^53 (JS doubles) — and the loss would be
  // baked into the AC-1 signature digest (sha3 of the calldata), so the node would apply a
  // truncated amount. _amt() normalizes any caller input (Number/BigInt/string) to the
  // canonical base-10 u64 string that serde serializes byte-identically here and node-side.
  _amt(amount) {
    try {
      return toU64String(typeof amount === 'string' ? amount.replace(/^0+(?=\d)/, '') : amount);
    } catch (_) {
      throw new Error('amount must be a u64 integer: a string, a bigint, or a number up to 2^53');
    }
  }
  async qrc20Transfer(contract, to, amount, password, opts) {
    return this.buildContractCall(contract, 'transfer', [WalletManager.recipientAddress(to), this._amt(amount)], password, opts);
  }
  // QNC fee (gas_debit) the chain prepays for qrc20Transfer(contract, to, amount) at the default gas.
  qrc20TransferFeeNano(contract, to, amount) {
    return feeNano(GAS_PRICE, contractCallIntrinsicGas(contractCallData(contract, 'transfer', [to, this._amt(amount)])));
  }
  // QNC the sender must hold: the fee, plus a refundable deposit when the recipient holds none of the token. The
  // recipient counts as a holder only by a balance a send may be decided by (checkedTokenBalance: committee-certified),
  // never by one node's word (MOB-BR-R3-03); anything else counts as none, the safe side. The recipient's account nonce
  // is not the send's, so no proof read earlier stands in for a fresh one.
  async qrc20TransferQncNeedNano(contract, to, amount) {
    const fee = this.qrc20TransferFeeNano(contract, to, amount);
    const r = await this.checkedTokenBalance(contract, to, null, { nonce: null }).catch(() => null);
    const holds = !!r && r.ok && r.verified === true && /^\d+$/.test(String(r.balanceBase)) && BigInt(r.balanceBase) > 0n;
    const depositNano = holds ? 0 : STORAGE_DEPOSIT_NANO;
    return { feeNano: fee, depositNano, needNano: fee + depositNano };
  }
  async qrc20Approve(contract, spender, amount, password, opts) {
    return this.buildContractCall(contract, 'approve', [WalletManager.recipientAddress(spender), this._amt(amount)], password, opts);
  }
  async qrc20TransferFrom(contract, from, to, amount, password, opts) {
    return this.buildContractCall(contract, 'transferFrom',
      [WalletManager.recipientAddress(from), WalletManager.recipientAddress(to), this._amt(amount)], password, opts);
  }
  async qrc20Mint(contract, to, amount, password, opts) {
    return this.buildContractCall(contract, 'mint', [WalletManager.recipientAddress(to), this._amt(amount)], password, opts);
  }
  async qrc20Burn(contract, amount, password, opts) {
    return this.buildContractCall(contract, 'burn', [this._amt(amount)], password, opts);
  }

  // QRC-721 (NFT) convenience wrappers — same ContractCall path/signature as QRC-20, so the
  // AC-1 digest (sha3 of the alphabetical {"args","contract","method"} calldata) is produced
  // identically. token_id is ALWAYS a decimal STRING (node reads it from a contract_storage
  // string key and via string-or-number amount parsing) — a JSON number would truncate above
  // 2^53 and bake the loss into the signed digest. Args mirror the node apply arms exactly:
  //   mint[to,token_id] transfer[to,token_id] approve[spender,token_id]
  //   transferFrom[from,to,token_id]
  // _tokenId() normalizes Number/BigInt/string to the canonical base-10 integer string.
  _tokenId(tokenId) {
    // Reuses the amount normalizer: a token_id is a non-negative integer with the same
    // full-u64 string-exactness requirement.
    return this._amt(tokenId);
  }
  async nftMint(contract, to, tokenId, password, opts) {
    return this.buildContractCall(contract, 'mint', [WalletManager.recipientAddress(to), this._tokenId(tokenId)], password, opts);
  }
  async nftTransfer(contract, to, tokenId, password, opts) {
    return this.buildContractCall(contract, 'transfer', [WalletManager.recipientAddress(to), this._tokenId(tokenId)], password, opts);
  }
  async nftApprove(contract, spender, tokenId, password, opts) {
    return this.buildContractCall(contract, 'approve', [WalletManager.recipientAddress(spender), this._tokenId(tokenId)], password, opts);
  }
  async nftTransferFrom(contract, from, to, tokenId, password, opts) {
    return this.buildContractCall(contract, 'transferFrom',
      [WalletManager.recipientAddress(from), WalletManager.recipientAddress(to), this._tokenId(tokenId)], password, opts);
  }

  // One length-prefixed field of a canonical deploy digest: "{utf8_byte_len}:{value}". Mirrors
  // deploy_digest_field in qnet-state; the length prefix is what stops a relayer re-splitting
  // ':'-joined fields (name "A:B" vs symbol "B:C") under an unchanged signature.
  _deployField(value) {
    const s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    return `${new TextEncoder().encode(s).length}:${s}`;
  }

  // Deploy a QRC-20 token via the node's /api/v1/token/deploy endpoint. The node
  // derives the on-chain contract address (derive_contract_address(from, nonce)) and
  // builds tx.data itself, so the signature binds the canonical deploy message it
  // reproduces: q{chain}|contract_deploy:{from}:{code_hash}:{nonce}:{gas_price}:{gas_limit}, where code_hash is
  // the canonical deploy digest below — it commits to EVERY field the chain applies, so
  // no relayer can alter the token under this signature.
  async deployToken({ name, symbol, decimals = 9, initialSupply, mintable = false, burnable = false, logo = '' }, password, opts = {}) {
    if (!name || !symbol) throw new Error('name and symbol are required');
    if (!(initialSupply > 0)) throw new Error('initialSupply must be greater than 0');
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);

    const { signDetached } = require('../crypto/DilithiumCrypto');
    const { sha3_256 } = require('js-sha3');

    // Mirrors qnet-state deploy_code_hash(DeployKind::Qrc20, ..) — NIST FIPS 202.
    const codeHash = sha3_256(
      'QRC20|' + this._deployField(name) + this._deployField(symbol) +
      this._deployField(decimals) + this._deployField(initialSupply) +
      this._deployField(!!mintable) + this._deployField(!!burnable) +
      this._deployField(logo));
    const sent = await this._signAndSubmit(from, async (txNonce) => {
      const message = contractDeployPreimage(from, codeHash, txNonce, DEPLOY_GAS_PRICE, DEPLOY_GAS_LIMIT);
      return {
        path: '/api/v1/token/deploy', pk: dilPkHex,
        body: {
          from, name, symbol, decimals, initial_supply: initialSupply, nonce: txNonce,
          mintable, burnable, logo,
          dilithium_signature: await signDetached(message, dilSkHex), dilithium_public_key: dilPkHex,
        },
      };
    }, { kind: 'deploy', spend: { qncNano: String(feeNano(DEPLOY_GAS_PRICE, DEPLOY_GAS_LIMIT)) } }, { choice: opts.choice || null });
    return WalletManager._acceptedOrUnknown(sent, 'token deploy');
  }

  // Deploy a QRC-721 (NFT) collection. Mirrors deployToken's ContractDeploy path exactly:
  // the node derives the on-chain contract address (derive_contract_address(from, nonce)),
  // builds tx.data server-side as {"qrc721":true,"name":..,"symbol":..}, and the value-TX gate
  // rebuilds the SAME canonical deploy message this signs — q{chain}|contract_deploy:{from}:{code_hash}:{nonce}:{gas_price}:{gas_limit}
  // — then binds the ML-DSA-65 key to `from`. The digest mirrors qnet-state
  // deploy_code_hash(DeployKind::Qrc721, ..) byte for byte.
  async deployNftCollection({ name, symbol }, password, opts = {}) {
    if (!name || !symbol) throw new Error('name and symbol are required');
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);

    const { signDetached } = require('../crypto/DilithiumCrypto');
    const { sha3_256 } = require('js-sha3');

    // Mirrors qnet-state deploy_code_hash(DeployKind::Qrc721, ..) — NIST FIPS 202.
    const codeHash = sha3_256('QRC721|' + this._deployField(name) + this._deployField(symbol));
    const sent = await this._signAndSubmit(from, async (txNonce) => {
      const message = contractDeployPreimage(from, codeHash, txNonce, DEPLOY_GAS_PRICE, DEPLOY_GAS_LIMIT);
      return {
        path: '/api/v1/nft/deploy', pk: dilPkHex,
        body: {
          from, name, symbol, nonce: txNonce,
          dilithium_signature: await signDetached(message, dilSkHex), dilithium_public_key: dilPkHex,
        },
      };
    }, { kind: 'deploy', spend: { qncNano: String(feeNano(DEPLOY_GAS_PRICE, DEPLOY_GAS_LIMIT)) } }, { choice: opts.choice || null });
    return WalletManager._acceptedOrUnknown(sent, 'NFT collection deploy');
  }

  // A stored vault, readable or not: a copy that fails to parse is never deleted (see vaultState). A read error
  // answers false here, so nothing destructive may follow this answer; prepareInstall and every onboarding gate
  // use vaultState / canStoreNewWallet, which keep "unreadable" apart from "none" (MVA-R3-01).
  async walletExists() {
    try {
      const pairs = await AsyncStorage.multiGet([WalletManager.VAULT_KEY, WalletManager.VAULT_BACKUP_KEY]);
      return pairs.some(([, v]) => !!v);
    } catch (error) {
      return false;
    }
  }
  // Get current wallet without password (returns null if not available)
  async getCurrentWallet() {
    try {
      // We can't get decrypted wallet without password, 
      // but we can return basic structure that loadBalance needs
      const exists = await this.walletExists();
      if (!exists) {
        return null;
      }
      
      // Return a minimal wallet structure with what we know
      const solanaAddress = await AsyncStorage.getItem('qnet_wallet_address');
      if (solanaAddress) {
        // Trust the cached QNet address ONLY if a prior unlock stamped it under the current
        // FIPS-204 scheme. A cache from the old round-3 build (still a valid 45-char eon with a
        // valid checksum) would otherwise be returned verbatim and diverge from the node. We
        // cannot re-derive here (no password) — leave it null so the UI waits for the next
        // unlock, which re-derives via generateQNetAddress and stamps the scheme. Never fall
        // back to the Solana-bridge address (non-Dilithium — it can never match the node).
        let qnetAddress = await AsyncStorage.getItem('qnet_address');
        const scheme = await AsyncStorage.getItem('qnet_address_scheme');
        if (scheme !== 'fips204' || !qnetAddress || qnetAddress.length !== 45) {
          qnetAddress = null;
        }

        return {
          address: solanaAddress,
          solanaAddress: solanaAddress,
          qnetAddress: qnetAddress,
          publicKey: solanaAddress // Use Solana address as publicKey
        };
      }
      return null;
    } catch (error) {
      // console.error('Error getting current wallet:', error);
      return null;
    }
  }
}

export default WalletManager;
