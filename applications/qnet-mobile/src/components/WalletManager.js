import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native'; // Clear in-memory derived key when app backgrounds
import CryptoJS from 'crypto-js'; // Required for generateQNetAddress, generateMnemonic
import 'react-native-get-random-values'; // Must be imported first — polyfills crypto.getRandomValues
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl'; // Ed25519 signing for node operations
import * as Keychain from 'react-native-keychain';
// v3.35: Centralized node configuration (no duplication!)
// v4.10: Added getSolanaRpcUrl for centralized Solana RPC management
import { GENESIS_NODES, NODE_DISCOVERY, getRandomGenesisNode, getSolanaRpcUrl, rotateSolanaRpc } from '../config/nodes';
// Post-quantum BFT light-client: trustless committee-QC state-root verification
// (replaces the MITM-bypassable 2/3 peer-poll). MITM-proof at any network size.
import { verifyMacroblockStateRoot, verifyLogInclusion, verifyLogWindowInclusion, verifyMacroblockLogsRoot, transferLogLeaf } from '../crypto/QcLightClient';

export class WalletManager {
  constructor() {
    this.keyCache = null;       // Uint8Array (32-byte AES key), NOT the password
    this._keyCacheSalt = null;  // Hex salt that was used to derive keyCache
    this._keyCacheIter = 0;     // Iteration count used to derive keyCache
    this._failedAttempts = 0;
    this._lockoutUntil = 0;
    this._rateLimitLoaded = false;
    this._appStateSub = null;   // AppState subscription (clears keyCache on background)

    // BIP39 wordlist (2048 words)
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

    // Drop the derived AES key from heap the moment the app leaves the foreground,
    // so a backgrounded/locked process never holds the vault key in memory.
    this._appStateSub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') this._clearCachedKey();
    });
  }

  // Detach the AppState listener (call when tearing down this manager instance).
  dispose() {
    if (this._appStateSub) {
      this._appStateSub.remove();
      this._appStateSub = null;
    }
    this._clearCachedKey();
  }

  // Generate QNet address from mnemonic (extension-compatible)
  async generateQNetAddressFromMnemonic(mnemonic, accountIndex = 0) {
    try {
      // Convert mnemonic to seed using BIP39 standard
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      
      // Generate QNet address using BIP44 derivation
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
      const hash = CryptoJS.SHA512(solanaAddress + 'qnet-eon-bridge'); // Use hyphen for consistency
      const fullHash = hash.toString(CryptoJS.enc.Hex);
      
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
  
  // Re-derive the QNet address to the canonical pure-Dilithium identity.
  async migrateQNetAddress(wallet) {
    try {
      // Already on the current FIPS-204 identity — nothing to do. (A wallet from the old
      // round-3 build carries the previous 'QNET_WALLET_MLDSA65_v1' marker, so it does NOT
      // match here and falls through to be re-derived below.)
      if (wallet.qnetKeypair && wallet.qnetKeypair.path === 'QNET_WALLET_MLDSA65_fips204') {
        return wallet;
      }

      // Any wallet holding a mnemonic (including a stale Ed25519/BIP44 one) re-derives
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
        return wallet;
      }
      
      // No mnemonic - check if we need to generate address
      if (!wallet.qnetAddress) {
        // Generate from Solana as fallback
        wallet.qnetAddress = this.generateQNetAddressFromSolana(wallet.solanaAddress || wallet.address);
      }
      
      return wallet;
    } catch (error) {
      // console.error('Error migrating QNet address:', error);
      // Fallback to Solana-based generation
      if (!wallet.qnetAddress) {
        wallet.qnetAddress = this.generateQNetAddressFromSolana(wallet.solanaAddress || wallet.address);
      }
      return wallet;
    }
  }

  // Generate QNet EON address — PURE DILITHIUM (ML-DSA-65, F0.1). The QNet identity is the
  // post-quantum key derived from the mnemonic; the address commits to it. Byte-identical to the
  // node (genesis_key.rs): the native module SHAKE-256s the canonical seed string into the 32-byte
  // ML-DSA-65 KeyGen seed, then EON = SHA512(pk) formatted. Ed25519/Solana keys are derived
  // separately (m/44'/501') and are UNTOUCHED — Ed25519 is a Solana-only credential.
  async generateQNetAddress(seed, accountIndex = 0) {
    try {
      // Canonical wallet seed string — MUST byte-match the node's WALLET_SEED_PREFIX + hex(bip39_seed64).
      const seedHex = Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join('');
      const seedString = `QNET_WALLET_MLDSA65_v1:${seedHex}`;

      // Native ML-DSA-65 keygen: shake256(seedString) -> 32-byte xi -> keypair (hex pk 1952B / sk 4032B).
      const { generateRawDilithiumKeypair } = require('../crypto/DilithiumCrypto');
      const kp = await generateRawDilithiumKeypair(seedString);
      const pkBytes = Uint8Array.from(kp.publicKey.match(/.{1,2}/g).map(h => parseInt(h, 16)));
      const skBytes = Uint8Array.from(kp.secretKey.match(/.{1,2}/g).map(h => parseInt(h, 16)));

      // EON = SHA512(raw ML-DSA-65 pk bytes), formatted: 19 + "eon" + 15 + 8-hex SHA3-256 checksum.
      const addressHash = CryptoJS.SHA512(CryptoJS.lib.WordArray.create(pkBytes));
      const fullHash = addressHash.toString(CryptoJS.enc.Hex);
      const part1 = fullHash.substring(0, 19).toLowerCase();
      const part2 = fullHash.substring(19, 34).toLowerCase();
      const { sha3_256 } = require('js-sha3');
      const checksum = sha3_256(part1 + 'eon' + part2).substring(0, 8).toLowerCase();
      const address = `${part1}eon${part2}${checksum}`;

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

  // HD derivation for Solana using ed25519-hd-key (Phantom-compatible)
  async deriveHDKeypair(seed, accountIndex = 0) {
    try {
      // Use Phantom's standard derivation path: m/44'/501'/accountIndex'/0'
      // This ensures compatibility with Phantom, Solflare and other major Solana wallets
      const path = `m/44'/501'/${accountIndex}'/0'`;
      
      // Use ed25519-hd-key library for proper HD derivation
      // This is the same library used by Phantom wallet
      try {
        const seedHex = Array.from(seed)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        const { key } = derivePath(path, seedHex);
        return key;
      } catch (error) {
        console.error('HD derivation error:', error);
        // Fallback to simple derivation
        return seed.slice(0, 32);
      }
    } catch (error) {
      // console.error('HD derivation error:', error);
      // Fallback to direct seed for compatibility
      return seed.slice(0, 32);
    }
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

  // Generate new wallet with BIP39 mnemonic
  // EVM (secp256k1) derivation from the SAME BIP39 seed — standard Ethereum path m/44'/60'/0'/0/0.
  // Additive + independent: the same mnemonic also yields an EVM address (byte-identical to
  // MetaMask/ethers). QNet (ML-DSA-65) + Solana (Ed25519) derivations are UNTOUCHED. KAT: mnemonic
  // "abandon…about" → 0x9858EfFD232B4033E47d90003D41EC34EcaEda94.
  async deriveEvmWallet(seed) {
    // EVM is an ADDITIVE sub-feature. @noble/curves is now a direct dependency, but if it is ever
    // unresolvable (nested/strict install layout, or a future @scure/bip32 that vendors curves),
    // degrade gracefully (return null) instead of throwing out of core wallet creation. QNet +
    // Solana identity must still be created even if the EVM address cannot be derived.
    try {
      const { HDKey } = require('@scure/bip32');
      const { secp256k1 } = require('@noble/curves/secp256k1');
      const { keccak256 } = require('js-sha3');
      const seedBytes = seed instanceof Uint8Array ? seed : new Uint8Array(seed);
      const hd = HDKey.fromMasterSeed(seedBytes).derive("m/44'/60'/0'/0/0");
      const priv = hd.privateKey;
      const pub = secp256k1.getPublicKey(priv, false); // 65B uncompressed 0x04||X||Y
      const addrHex = keccak256(pub.slice(1)).slice(-40); // keccak256(pubkey[1:])[-20 bytes]
      const hashHex = keccak256(addrHex); // EIP-55 checksum over the lowercase hex
      let address = '0x';
      for (let i = 0; i < 40; i++) address += (parseInt(hashHex[i], 16) >= 8 ? addrHex[i].toUpperCase() : addrHex[i]);
      return { address, privateKey: Buffer.from(priv).toString('hex'), publicKey: Buffer.from(pub).toString('hex'), path: "m/44'/60'/0'/0/0" };
    } catch (error) {
      // console.warn('EVM derivation unavailable, omitting evm field:', error);
      return null;
    }
  }

  async generateWallet() {
    try {
      // Generate BIP39 mnemonic with checksum using bip39 library
      const mnemonic = bip39.generateMnemonic();
      
      // Use ASYNC seed generation to avoid blocking UI
      const seed = await this.mnemonicToSeedAsync(mnemonic);
      
      // Use HD derivation for Solana like Phantom wallet
      const keypairSeed = await this.deriveHDKeypair(seed, 0);
      
      // Create keypair from derived seed  
      const keypair = Keypair.fromSeed(keypairSeed);
      
      // Generate QNet address and keypair using BIP44 derivation (reuse seed!)
      const qnetResult = await this.generateQNetAddress(seed, 0);

      // EVM address from the SAME seed (m/44'/60') — mnemonic portability to Ethereum/EVM networks.
      const evmResult = await this.deriveEvmWallet(seed);

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
        // EVM is additive: if deriveEvmWallet returned null (curves unresolvable), omit it —
        // core QNet + Solana wallet creation still succeeds.
        evmAddress: evmResult ? evmResult.address : null,
        evmKeypair: evmResult ? { publicKey: evmResult.publicKey, privateKey: evmResult.privateKey, path: evmResult.path } : null
      };

      // Temporarily attach mnemonic for storage only
      wallet._tempMnemonic = mnemonic;
      return wallet;
    } catch (error) {
      // console.error('Error generating wallet:', error);
      throw error;
    }
  }

  // Generate BIP39 mnemonic (12 words) with proper checksum
  async generateMnemonic() {
    const words = this.BIP39_WORDLIST;
    
    try {
      // Generate proper BIP39 mnemonic with checksum
      const entropy = new Uint8Array(16); // 128 bits for 12 words
      
      // Use native crypto-secure random values (from react-native-get-random-values)
      // This is much more secure and faster than CryptoJS on mobile
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(entropy);
      } else {
        // This should never happen with react-native-get-random-values imported
        throw new Error('Secure random number generator not available - critical security issue');
      }
      
      // Calculate SHA-256 hash for checksum using CryptoJS
      const entropyWordArray = CryptoJS.lib.WordArray.create(entropy);
      const hash = CryptoJS.SHA256(entropyWordArray);
      const hashBytes = [];
      for (let i = 0; i < 4; i++) {
        hashBytes.push((hash.words[0] >> (24 - i * 8)) & 0xff);
      }
      
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
      // console.error('Error generating BIP39 mnemonic:', error);
      throw new Error('Failed to generate secure mnemonic');
    }
  }

  // Validate BIP39 mnemonic with checksum
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
          return { valid: false, error: `Word "${word}" is not in BIP39 wordlist.` };
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
      const entropyWordArray = CryptoJS.lib.WordArray.create(entropy);
      const hash = CryptoJS.SHA256(entropyWordArray);
      const hashBytes = [];
      for (let i = 0; i < 4; i++) {
        hashBytes.push((hash.words[0] >> (24 - i * 8)) & 0xff);
      }

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
      // console.error('Error validating BIP39 mnemonic:', error);
      return { valid: false, error: 'Failed to validate mnemonic.' };
    }
  }

  // Get BIP39 wordlist (helper function)
  getBIP39WordList() {
    // Return the full BIP39 wordlist
    return this.BIP39_WORDLIST;
  }

  // Import wallet from mnemonic with BIP39 validation
  async importWallet(mnemonic) {
    try {
      // Validate BIP39 mnemonic using bip39 library
      const trimmedMnemonic = mnemonic.trim();
      if (!bip39.validateMnemonic(trimmedMnemonic)) {
        throw new Error('Invalid mnemonic phrase');
      }

      // Use ASYNC seed generation to avoid blocking UI
      const seed = await this.mnemonicToSeedAsync(trimmedMnemonic);
      
      // Use HD derivation for Solana like Phantom wallet
      const keypairSeed = await this.deriveHDKeypair(seed, 0);
      
      // Create keypair from derived seed
      const keypair = Keypair.fromSeed(keypairSeed);
      
      // Generate QNet address and keypair using BIP44 derivation
      const qnetResult = await this.generateQNetAddress(seed, 0);

      // EVM address from the SAME seed (m/44'/60') — mnemonic portability to Ethereum/EVM networks.
      const evmResult = await this.deriveEvmWallet(seed);

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
        // EVM is additive: if deriveEvmWallet returned null (curves unresolvable), omit it —
        // core QNet + Solana wallet import still succeeds.
        evmAddress: evmResult ? evmResult.address : null,
        evmKeypair: evmResult ? { publicKey: evmResult.publicKey, privateKey: evmResult.privateKey, path: evmResult.path } : null,
        imported: true
      };
      
      // Also keep temp reference for storage
      wallet._tempMnemonic = trimmedMnemonic;
      return wallet;
    } catch (error) {
      // console.error('Error importing wallet:', error);
      throw new Error(error.message || 'Failed to import wallet. Please check your seed phrase and try again.');
    }
  }

  // Get mnemonic securely from encrypted storage
  async getEncryptedMnemonic(password) {
    try {
      const storedWallet = await AsyncStorage.getItem('qnet_wallet');
      if (!storedWallet) return null;
      
      const vaultData = JSON.parse(storedWallet);
      
      // Decrypt to get mnemonic
      let plaintext;
      if (vaultData.version === 3 || vaultData.version === 2) {
        plaintext = await this._decryptGCM(vaultData, password);
      } else {
        plaintext = await this._decryptCBC(vaultData, password);
      }
      const walletData = JSON.parse(plaintext);
      return walletData.mnemonic || null;
    } catch (error) {
      return null;
    }
  }

  // ── Rate limiting (exponential backoff on failed password attempts) ──

  static KEYCHAIN_SERVICE = 'com.qnet.wallet.biometric';

  async _loadRateLimitState() {
    if (this._rateLimitLoaded) return;
    try {
      const raw = await AsyncStorage.getItem('qnet_rate_limit');
      if (raw) {
        const { attempts, lockoutUntil } = JSON.parse(raw);
        this._failedAttempts = attempts || 0;
        this._lockoutUntil = lockoutUntil || 0;
      }
    } catch { /* ignore */ }
    this._rateLimitLoaded = true;
  }

  async _saveRateLimitState() {
    try {
      await AsyncStorage.setItem('qnet_rate_limit', JSON.stringify({
        attempts: this._failedAttempts,
        lockoutUntil: this._lockoutUntil,
      }));
    } catch { /* ignore */ }
  }

  _lockoutMs(n) {
    if (n < 3) return 0;
    return Math.min(1000 * Math.pow(2, n - 3), 300_000);
  }

  async _recordFailedAttempt() {
    this._failedAttempts++;
    const delay = this._lockoutMs(this._failedAttempts);
    if (delay > 0) this._lockoutUntil = Date.now() + delay;
    await this._saveRateLimitState();
  }

  async _resetRateLimit() {
    this._failedAttempts = 0;
    this._lockoutUntil = 0;
    await this._saveRateLimitState();
  }

  async getPasswordLockStatus() {
    await this._loadRateLimitState();
    const now = Date.now();
    if (this._lockoutUntil > now) {
      return { locked: true, remainingMs: this._lockoutUntil - now, attempts: this._failedAttempts };
    }
    return { locked: false, remainingMs: 0, attempts: this._failedAttempts };
  }

  // ── Keychain / biometric unlock ──────────────────────────────────────

  async isBiometricSupported() {
    try {
      const type = await Keychain.getSupportedBiometryType();
      return !!type;
    } catch { return false; }
  }

  async getBiometryType() {
    try {
      return await Keychain.getSupportedBiometryType();
    } catch { return null; }
  }

  async isBiometricEnabled() {
    try {
      const creds = await Keychain.getGenericPassword({
        service: WalletManager.KEYCHAIN_SERVICE,
      });
      return !!creds;
    } catch { return false; }
  }

  async enableBiometricUnlock(password) {
    try {
      const type = await Keychain.getSupportedBiometryType();
      if (!type) return false;
      await Keychain.setGenericPassword('qnet_wallet', password, {
        service: WalletManager.KEYCHAIN_SERVICE,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      return true;
    } catch { return false; }
  }

  async disableBiometricUnlock() {
    try {
      await Keychain.resetGenericPassword({ service: WalletManager.KEYCHAIN_SERVICE });
      return true;
    } catch { return false; }
  }

  async tryBiometricUnlock() {
    try {
      const creds = await Keychain.getGenericPassword({
        service: WalletManager.KEYCHAIN_SERVICE,
        authenticationPrompt: { title: 'Unlock QNet Wallet' },
      });
      if (!creds || !creds.password) return null;
      return creds.password;
    } catch { return null; }
  }

  // ---------------------------------------------------------------------------
  // Secure crypto helpers (Web Crypto API — AES-256-GCM + PBKDF2)
  // Vault format v3: { version:3, salt, iv, encrypted } — PBKDF2 600K (current)
  // Vault format v2: { version:2, salt, iv, encrypted } — PBKDF2 100K (legacy, auto-migrates)
  // ---------------------------------------------------------------------------

  static VAULT_ITERATIONS_V3 = 600_000; // OWASP 2024 recommendation
  static VAULT_ITERATIONS_V2 = 100_000; // Legacy — kept for backward compat decrypt

  // Derive 32-byte AES key from password + hex salt via PBKDF2-SHA256.
  // Uses @noble/hashes pbkdf2Async — truly non-blocking: yields to JS event loop
  // every ~10 ms so the UI stays responsive during 600K iterations on mobile.
  // Lazy require() avoids top-level ESM import issues with Hermes at module init.
  // Returns Uint8Array(32) — the raw AES-256 key bytes.
  async _deriveKeyNative(password, saltHex, iterations = WalletManager.VAULT_ITERATIONS_V3) {
    // react-native-quick-crypto provides crypto.subtle backed by OpenSSL on a C++ JSI thread.
    // PBKDF2 runs natively — never blocks the JS thread — completes in < 1 second.
    // Use Buffer.from() instead of TextEncoder — Buffer is always available via QuickCrypto.install().
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

  // Set keyCache and remember which salt/iterations produced it.
  _setCachedKey(key, saltHex, iterations) {
    this.keyCache      = key;
    this._keyCacheSalt = saltHex;
    this._keyCacheIter = iterations;
  }

  // Clear keyCache on failed attempts or vault change.
  _clearCachedKey() {
    this.keyCache      = null;
    this._keyCacheSalt = null;
    this._keyCacheIter = 0;
  }

  // Encrypt plaintext string → { version:3, salt, iv, encrypted } (all hex).
  // Returns { vault, derivedKey } — derivedKey (Uint8Array) can be cached to avoid a 2nd PBKDF2 call.
  // AES-256-GCM via crypto-browserify; output layout matches crypto.subtle (ciphertext || 16-byte tag).
  async _encryptGCM(plaintext, password) {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await this._deriveKeyNative(password, this._bytesToHex(salt), WalletManager.VAULT_ITERATIONS_V3);
    const plaintextBytes = Buffer.from(plaintext == null ? '' : String(plaintext), 'utf8');
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintextBytes
    );
    const vault = {
      version:   3,
      salt:      this._bytesToHex(salt),
      iv:        this._bytesToHex(iv),
      encrypted: this._bytesToHex(new Uint8Array(cipherBuf)),
      timestamp: Date.now(),
    };
    return { vault, derivedKey: key };
  }

  // Decrypt vault v2 or v3 → plaintext string. Throws on wrong password.
  // AES-256-GCM via crypto-browserify; compatible with vaults encrypted by
  // crypto.subtle (ciphertext || 16-byte tag) and by _encryptGCM above.
  async _decryptGCM(vaultData, password) {
    const iterations = vaultData.version === 3
      ? WalletManager.VAULT_ITERATIONS_V3
      : WalletManager.VAULT_ITERATIONS_V2;
    // Reuse cached key if it was derived from the same salt+iterations.
    // This eliminates duplicate PBKDF2 calls when verifyPassword → loadWallet
    // are called back-to-back (every unlock).
    const canReuseCache =
      this.keyCache &&
      this._keyCacheSalt === vaultData.salt &&
      this._keyCacheIter === iterations;
    let key;
    if (canReuseCache) {
      key = this.keyCache;
    } else {
      key = await this._deriveKeyNative(password, vaultData.salt, iterations);
      this._setCachedKey(key, vaultData.salt, iterations);
    }
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this._hexToBytes(vaultData.iv) },
      key,
      this._hexToBytes(vaultData.encrypted)
    );
    return Buffer.from(plainBuf).toString('utf8');
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

  // Legacy PBKDF2 (CryptoJS, kept ONLY to migrate old CBC vaults on first unlock).
  async _deriveKeyLegacy(password, saltHex) {
    const salt = CryptoJS.enc.Hex.parse(saltHex);
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(CryptoJS.PBKDF2(password, salt, {
          keySize: 256 / 32, iterations: 10000, hasher: CryptoJS.algo.SHA256
        }));
      }, 0);
    });
  }

  // Legacy AES-CBC decrypt (CryptoJS, for migrating old vaults only).
  async _decryptCBC(vaultData, password) {
    const salt = CryptoJS.enc.Hex.parse(vaultData.salt);
    const iv   = CryptoJS.enc.Hex.parse(vaultData.iv);
    const key  = await this._deriveKeyLegacy(password, vaultData.salt);
    const dec  = CryptoJS.AES.decrypt(vaultData.encrypted, key,
      { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    const str  = dec.toString(CryptoJS.enc.Utf8);
    if (!str) throw new Error('Wrong password or corrupted wallet');
    return str;
  }

  // Encrypt and store wallet with PBKDF2 + AES (like extension)
  async storeWallet(walletData, password) {
    try {
      // Only clear activation codes when it's a DIFFERENT wallet
      // (import/create already clears them explicitly in WalletScreen)
      // Previously this line deleted codes on EVERY save, causing data loss
      const existingAddress = await AsyncStorage.getItem('qnet_wallet_address');
      if (existingAddress && walletData.address && existingAddress !== walletData.address) {
        // Different wallet — clear old activation codes
        await AsyncStorage.removeItem('qnet_activation_codes');
      }
      
      // Extract and use temporary mnemonic if present
      const mnemonic = walletData._tempMnemonic || walletData.mnemonic;
      if (walletData._tempMnemonic) {
        delete walletData._tempMnemonic; // Clear from memory immediately
      }
      if (walletData.mnemonic) {
        delete walletData.mnemonic; // Clear from memory immediately
      }
      
      // Create storage data with mnemonic
      const storageData = {
        ...walletData,
        mnemonic: mnemonic // Will be encrypted below
      };
      
      // Encrypt wallet data — AES-256-GCM + PBKDF2 600K (v3)
      // derivedKey is reused for keyCache — no 2nd PBKDF2 call
      const { vault: vaultData, derivedKey: vaultKey } = await this._encryptGCM(JSON.stringify(storageData), password);
      this._setCachedKey(vaultKey, vaultData.salt, WalletManager.VAULT_ITERATIONS_V3);

      await AsyncStorage.setItem('qnet_wallet', JSON.stringify(vaultData));
      await AsyncStorage.setItem('qnet_wallet_address', walletData.address);
      
      return true;
    } catch (error) {
      // console.error('Error storing wallet:', error);
      throw error;
    }
  }

  // Get available node for direct connection - fully decentralized
  async getAvailableNode() {
    try {
      // First try to get cached discovered nodes
      const cachedNodes = await AsyncStorage.getItem('qnet_discovered_nodes');
      if (cachedNodes) {
        const nodes = JSON.parse(cachedNodes);
        const validNodes = nodes.filter(node => {
          // Check if node was seen in last 24 hours
          return (Date.now() - node.lastSeen) < 86400000;
        });
        
        if (validNodes.length > 0) {
          // Use discovered node
          const node = validNodes[Math.floor(Math.random() * validNodes.length)];
          return node.url;
        }
      }
    } catch (e) {
      // Ignore cache errors
    }
    
    // Fallback to the canonical Genesis list (single source: config/nodes.js).
    const genesisNodes = GENESIS_NODES.map(url => ({ url }));

    // Try to discover new nodes from Genesis nodes
    this.discoverNodes(genesisNodes);
    
    // Return random Genesis node for now
    const node = genesisNodes[Math.floor(Math.random() * genesisNodes.length)];
    return node.url;
  }
  
  // Discover active nodes from network
  // v3.13: Discover active nodes from network (stores reputation!)
  async discoverNodes(seedNodes) {
    try {
      // Query each seed node for their peer list
      for (const seed of seedNodes) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(`${seed.url}/api/v1/peers`, {
            method: 'GET',
            signal: controller.signal, // `timeout:` is ignored by fetch — use AbortController
          }).finally(() => clearTimeout(t));

          if (response.ok) {
            const data = await response.json();
            if (data.peers && Array.isArray(data.peers)) {
              // v3.13: Store discovered nodes WITH reputation for filtering
              const discoveredNodes = data.peers
                .filter(peer => peer.address && peer.address.includes(':'))
                .map(peer => ({
                  url: peer.address.startsWith('http') ? peer.address : `http://${peer.address}`,
                  nodeType: peer.node_type,
                  reputation: peer.reputation || 0, // v3.13: Store reputation!
                  lastSeen: Date.now()
                }));
              
              // Merge with existing cache
              const cachedNodes = await AsyncStorage.getItem('qnet_discovered_nodes');
              let allNodes = discoveredNodes;
              if (cachedNodes) {
                const existing = JSON.parse(cachedNodes);
                allNodes = [...existing, ...discoveredNodes];
                
                // Remove duplicates (prefer newer data)
                const unique = {};
                allNodes.forEach(node => {
                  unique[node.url] = node;
                });
                allNodes = Object.values(unique);
              }
              
              // Save to cache
              await AsyncStorage.setItem('qnet_discovered_nodes', JSON.stringify(allNodes));
              break; // Success, no need to query more seeds
            }
          }
        } catch (e) {
          // Try next seed node
          continue;
        }
      }
    } catch (e) {
      // Discovery failed silently
    }
  }
  
  // v3.31: PRODUCTION-READY node selection with discovery + caching
  // v3.35: Genesis nodes ARE in the discovered list (from /api/v1/validators/proof)
  // ONLY used directly for FIRST LAUNCH bootstrap when cache is empty
  
  // In-memory cache for fast access (synced with AsyncStorage)
  // v3.35: Cache contains ALL validators including Genesis (verified via Merkle)
  static discoveredNodesCache = null;
  static lastDiscoveryTime = 0;
  static nodeHealth = {};   // baseUrl -> { ewmaMs, fails, lastFailAt } — client-side latency/failure
  static nonceCache = {};   // address -> { next, at } — local nonce, re-anchored on staleness/error
  
  // v3.36: Synchronous node getter - uses cache with weighted random
  // Genesis nodes ARE in the cache - NO SEPARATE FALLBACK!
  // 
  // SCALABILITY: Load distributed across ALL eligible nodes (100K+)
  // Each node gets proportional traffic based on reputation
  getRandomBootstrapNode() {
    // Cache contains ALL validators (Genesis + Super) from verified Merkle proof
    if (WalletManager.discoveredNodesCache && WalletManager.discoveredNodesCache.length > 0) {
      const currentTime = Math.floor(Date.now() / 1000);
      const eligibleNodes = WalletManager.discoveredNodesCache.filter(n => {
        const age = currentTime - (n.lastSeen || 0);
        return age < NODE_DISCOVERY.MAX_STALE_SECS && 
               n.reputation >= NODE_DISCOVERY.MIN_REPUTATION && 
               n.isSynced !== false;
      });
      
      if (eligibleNodes.length > 0) {
        // Weighted random by BLOCKCHAIN reputation
        // Higher reputation = higher chance (but ALL eligible nodes participate!)
        // Genesis and Super nodes compete equally - no special treatment
        const totalRep = eligibleNodes.reduce((sum, n) => sum + (n.reputation || 0.7), 0);
        let random = Math.random() * totalRep;
        for (const node of eligibleNodes) {
          random -= (node.reputation || 0.7);
          if (random <= 0) {
            return node.url;
          }
        }
        return eligibleNodes[0].url;
      }
    }
    
    // FIRST LAUNCH ONLY - cache is empty
    // Genesis used ONCE to bootstrap, then cache takes over
    this.refreshNodeDiscovery();
    return getRandomGenesisNode();
  }
  
  // --- Scalable node client: health-ranked selection + hedged, timeout-bounded requests ---------
  // Every remote call is capped by a timeout and hedged across two nodes, so one slow/unreachable
  // node can never stall a send; load stays spread across the whole validator set.

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

  // Up to `count` distinct eligible nodes, weighted-random by reputation (spreads load), skipping
  // recently-failing ones. Falls back to a genesis node only when the discovery cache is cold.
  getRankedNodes(count = 2) {
    const cache = WalletManager.discoveredNodesCache;
    let pool = [];
    if (cache && cache.length > 0) {
      const now = Math.floor(Date.now() / 1000);
      const eligible = (n) => (now - (n.lastSeen || 0)) < NODE_DISCOVERY.MAX_STALE_SECS
        && n.reputation >= NODE_DISCOVERY.MIN_REPUTATION && n.isSynced !== false;
      pool = cache.filter(n => eligible(n) && !this._recentlyFailed(n.url));
      if (pool.length === 0) pool = cache.filter(eligible);   // relax if all transiently marked bad
    }
    const urls = [];
    const picks = pool.slice();
    while (urls.length < count && picks.length > 0) {
      const total = picks.reduce((s, n) => s + (n.reputation || 0.7), 0);
      let r = Math.random() * total, idx = 0;
      for (let i = 0; i < picks.length; i++) { r -= (picks[i].reputation || 0.7); if (r <= 0) { idx = i; break; } }
      urls.push(picks[idx].url); picks.splice(idx, 1);
    }
    if (urls.length === 0) { this.refreshNodeDiscovery(); urls.push(getRandomGenesisNode()); }
    return urls;
  }

  // Hedged request: fire the primary; if silent for hedgeMs, race a second node in parallel; first
  // success wins and aborts the rest; a failing node hands off to the next at once. Each attempt is
  // capped by timeoutMs. POST is safe to hedge — a signed TX is content-addressed, so the mempool
  // dedups a double-submit.
  async _hedged(path, { method = 'GET', body = null, timeoutMs = 4000, hedgeMs = 700, nodes = null, raw = false } = {}) {
    const bases = nodes || this.getRankedNodes(2);
    const ctrls = [];
    let settled = false, launched = 0, pending = 0, lastErr = null;
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
      const launch = (i) => {
        if (settled || i >= bases.length) return;
        launched++; pending++;
        run(bases[i]).then((res) => {
          if (settled) return;
          settled = true; ctrls.forEach(c => { try { c.abort(); } catch (_) {} }); resolve(res);
        }).catch((e) => {
          pending--; lastErr = e;
          if (settled) return;
          if (launched < bases.length) launch(launched);            // failed → next immediately
          else if (pending === 0) reject(lastErr || new Error('all nodes failed'));
        });
      };
      launch(0);
      if (bases.length > 1) setTimeout(() => { if (!settled && launched < 2) launch(1); }, hedgeMs);
    });
  }

  // Submit a signed TX (hedged POST). Gossip routes it to the current producer within ~1 microblock,
  // so no producer-lookup round-trip is needed.
  async submitSignedTx(txPayload) {
    const res = await this._hedged('/api/v1/transaction', { method: 'POST', body: txPayload, timeoutMs: 5000, hedgeMs: 900 });
    return res.data || {};
  }

  // Nonce for the next TX from `address`, tracked locally so back-to-back sends skip the round-trip;
  // re-anchored from chain when stale (TTL) or forced after a nonce-rejected submit.
  async resolveNonce(address, forceFresh = false) {
    const cached = WalletManager.nonceCache[address];
    if (!forceFresh && cached && (Date.now() - cached.at) < 15000) return cached.next;
    let accountNonce = 0;
    try {
      const res = await this._hedged(`/api/v1/account/${address}`, { timeoutMs: 4000, hedgeMs: 700 });
      if (res.ok && res.data) accountNonce = res.data.nonce || 0;
      else if (cached) return cached.next;
    } catch (e) {
      if (cached) return cached.next;
      console.warn('[SEND] nonce fetch failed, assuming 0:', e.message);
    }
    const next = accountNonce + 1;
    WalletManager.nonceCache[address] = { next, at: Date.now() };
    return next;
  }

  _bumpNonce(address, usedNonce) {
    WalletManager.nonceCache[address] = { next: usedNonce + 1, at: Date.now() };
  }

  // PURE DILITHIUM (F0.1): the light node's on-chain attestation root, ping delegation, and reward-claim
  // proofs are ALL signed by the ML-DSA-65 WALLET key (the key whose SHA512 IS wallet_address). Returns it
  // as hex {secretKey, publicKey} for signWithDilithium — replaces the legacy per-node identity key so the
  // RAM quantum_pubkey == the on-chain root (load_vrf_public_key) and background/foreground pings verify.
  async _walletDilithiumKeys(password, walletData = null) {
    const wd = walletData || await this.loadWallet(password);
    const qk = wd && wd.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey) {
      throw new Error('No ML-DSA-65 QNet key in wallet (pure-Dilithium identity unavailable)');
    }
    return {
      secretKey: Buffer.from(new Uint8Array(qk.privateKey)).toString('hex'),
      publicKey: Buffer.from(new Uint8Array(qk.publicKey)).toString('hex'),
    };
  }

  // Async node getter with guaranteed fresh data
  async getNodeWithDiscovery() {
    // Load cache from storage if not loaded
    if (!WalletManager.discoveredNodesCache) {
      await this.loadNodesFromCache();
    }
    
    // Refresh if stale (use config)
    if (Date.now() - WalletManager.lastDiscoveryTime > NODE_DISCOVERY.DISCOVERY_INTERVAL_MS) {
      await this.refreshNodeDiscovery();
    }
    
    return this.getRandomBootstrapNode();
  }
  
  // Load cached nodes from AsyncStorage
  async loadNodesFromCache() {
    try {
      const cached = await AsyncStorage.getItem('qnet_discovered_nodes');
      if (cached) {
        WalletManager.discoveredNodesCache = JSON.parse(cached);
      }
    } catch (e) {
      WalletManager.discoveredNodesCache = [];
    }
  }
  
  // v3.36: Get random node for discovery requests
  // Uses cache if available, Genesis ONLY for first launch
  // NO SEPARATE FALLBACK - Genesis is in the cache!
  getRandomNodeForDiscovery() {
    // If cache exists and has nodes, use weighted random from cache
    if (WalletManager.discoveredNodesCache && WalletManager.discoveredNodesCache.length > 0) {
      const currentTime = Math.floor(Date.now() / 1000);
      
      // Filter eligible nodes (same criteria as everywhere)
      const eligibleNodes = WalletManager.discoveredNodesCache.filter(n => {
        const age = currentTime - (n.lastSeen || 0);
        return age < NODE_DISCOVERY.MAX_STALE_SECS && 
               n.reputation >= NODE_DISCOVERY.MIN_REPUTATION && 
               n.isSynced !== false;
      });
      
      if (eligibleNodes.length > 0) {
        // Weighted random selection (higher reputation = higher chance)
        const totalRep = eligibleNodes.reduce((sum, n) => sum + (n.reputation || 0.7), 0);
        let random = Math.random() * totalRep;
        for (const node of eligibleNodes) {
          random -= (node.reputation || 0.7);
          if (random <= 0) {
            return node.url;
          }
        }
        return eligibleNodes[0].url;
      }
    }
    
    // FIRST LAUNCH ONLY - cache is empty
    // Genesis nodes will be added to cache after first successful discovery
    return getRandomGenesisNode();
  }
  
  // v3.36: Refresh node discovery with TRUSTLESS verification
  // Uses /api/v1/validators/proof - data verified via Merkle proof
  // 
  // SCALABILITY FIX: Discovery goes to RANDOM node from cache (not just Genesis!)
  // Genesis nodes ARE in the cache - they are regular validators
  // Genesis used ONLY for FIRST LAUNCH when cache is empty
  async refreshNodeDiscovery(maxRetries = 3) {
    // Don't refresh too often
    if (Date.now() - WalletManager.lastDiscoveryTime < 30000) return;
    WalletManager.lastDiscoveryTime = Date.now();
    
    const triedNodes = new Set();
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // v3.36: Use node from CACHE if available (includes Genesis + Super)
        // Genesis only for FIRST LAUNCH when cache is empty
        // This distributes discovery load across ALL nodes!
        let seedUrl = this.getRandomNodeForDiscovery();
        let retryCount = 0;
        while (triedNodes.has(seedUrl) && retryCount < 10) {
          seedUrl = this.getRandomNodeForDiscovery();
          retryCount++;
        }
        triedNodes.add(seedUrl);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        // v3.32: Use new TRUSTLESS endpoint with Merkle proof
        const response = await fetch(`${seedUrl}/api/v1/validators/proof`, {
          method: 'GET',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // v3.32: Verify Merkle proof locally before trusting data!
        if (data.validators && data.merkle_root) {
          const proofValid = await this.verifyValidatorSetProof(data);
          
          if (!proofValid) {
            console.warn('[DISCOVERY] Validator set proof INVALID - node may be malicious!');
            throw new Error('Invalid Merkle proof'); // Retry on different node
          }
        }
        
        if (data.validators && Array.isArray(data.validators)) {
          // Filter active nodes - all data comes from BLOCKCHAIN (verified by proof!)
          // v3.35: Genesis nodes ARE in this list - no separate fallback needed!
          // Only Super/Genesis nodes (Light nodes are NOT real nodes)
          const nodes = data.validators
            .filter(v => v.address && v.is_active && v.reputation >= NODE_DISCOVERY.MIN_REPUTATION && v.is_synced !== false)
            .map(v => ({
              url: v.address.startsWith('http') ? v.address : `http://${v.address}`,
              reputation: v.reputation, // BLOCKCHAIN reputation - verified by proof!
              nodeType: v.node_type,
              nodeId: v.node_id,
              lastSeen: v.last_seen || Math.floor(Date.now() / 1000), // v3.35: REAL last_seen from P2P heartbeat (seconds)
              isSynced: v.is_synced !== false // v3.35: Sync status from node
            }));
          
          if (nodes.length > 0) {
            // Replace cache entirely (don't merge - we have fresh verified data)
            WalletManager.discoveredNodesCache = nodes;
            await AsyncStorage.setItem('qnet_discovered_nodes', 
              JSON.stringify(WalletManager.discoveredNodesCache)
            );
            return; // Success!
          }
        }
        
        throw new Error('Empty validators list');
      } catch (e) {
        lastError = e;
        // v3.35: Wait before retry (exponential backoff)
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 500));
        }
      }
    }
    
    // All retries failed
    console.warn(`[DISCOVERY] Failed after ${maxRetries} retries:`, lastError?.message);
    // Keep using existing cache if available
  }
  
  // Get ALL available nodes for redundant operations (sorted by blockchain reputation)
  // v3.35: NO FALLBACK - Genesis nodes ARE in discoveredNodesCache!
  // They come from /api/v1/validators/proof - verified via Merkle proof
  getAvailableNodes() {
    const currentTime = Math.floor(Date.now() / 1000);
    
    // v3.35: Genesis nodes ARE in this list (from validators/proof endpoint)
    // No separate fallback needed - they're first-class validators
    if (WalletManager.discoveredNodesCache && WalletManager.discoveredNodesCache.length > 0) {
      const filtered = WalletManager.discoveredNodesCache
        .filter(n => {
          const age = currentTime - (n.lastSeen || 0);
          return age < NODE_DISCOVERY.MAX_STALE_SECS && n.reputation >= NODE_DISCOVERY.MIN_REPUTATION && n.isSynced !== false;
        })
        .sort((a, b) => b.reputation - a.reputation) // Sorted by blockchain reputation
        .slice(0, 20)
        .map(n => n.url);
      
      // If all cached nodes were filtered out (stale/low reputation), fall back to Genesis
      if (filtered.length > 0) return filtered;
    }
    
    // ONLY if cache is completely empty (first app launch) or all filtered out
    // This triggers discovery which will populate cache with verified list
    this.refreshNodeDiscovery();
    return [...GENESIS_NODES];
  }

  // Load and decrypt wallet with PBKDF2 + AES
  async loadWallet(password) {
    try {
      const vaultDataStr = await AsyncStorage.getItem('qnet_wallet');
      if (!vaultDataStr) {
        throw new Error('No wallet found');
      }
      
      let vaultData;
      try {
        vaultData = JSON.parse(vaultDataStr);
      } catch (parseError) {
        // Corrupted data - clean up and throw error
        console.error('Corrupted wallet data:', parseError.message);
        await AsyncStorage.removeItem('qnet_wallet');
        await AsyncStorage.removeItem('qnet_wallet_address');
        throw new Error('Wallet data is corrupted. Please create a new wallet or import existing one.');
      }
      
      // Decrypt — support vault v1/v2/v3 with auto-migration to v3 (GCM 600K).
      // v0 (no salt, direct CryptoJS) was removed — those wallets are too old to exist in production.
      let plaintext;
      if (vaultData.version === 3 || vaultData.version === 2) {
        // v3: AES-256-GCM + PBKDF2 600K (current)
        // v2: AES-256-GCM + PBKDF2 100K (legacy, auto-migrates to v3)
        plaintext = await this._decryptGCM(vaultData, password);
      } else if (vaultData.salt) {
        // v1: AES-256-CBC + PBKDF2 10K (legacy) — migrate on first unlock
        plaintext = await this._decryptCBC(vaultData, password);
      } else {
        throw new Error('Unsupported wallet format. Please re-import using your recovery phrase.');
      }

      let wallet = JSON.parse(plaintext);

      // Migrate old QNet address format if needed
      wallet = await this.migrateQNetAddress(wallet);

      // Migrate to v3 (PBKDF2 600K) if vault is not already v3
      let migrated = false;
      const fromVersion = vaultData.version || 1;
      if (vaultData.version !== 3) {
        try {
          // derivedKey is reused for keyCache — no 2nd PBKDF2 call needed
          const { vault: newVault, derivedKey: newKey } = await this._encryptGCM(JSON.stringify(wallet), password);
          await AsyncStorage.setItem('qnet_wallet', JSON.stringify(newVault));
          this._setCachedKey(newKey, newVault.salt, WalletManager.VAULT_ITERATIONS_V3);
          migrated = true;
          console.log(`[INFO][WALLET] vault_migrated from_version=${fromVersion} to_version=3 iterations=${WalletManager.VAULT_ITERATIONS_V3}`);
        } catch (migrationError) {
          // Migration failed — wallet is still readable (old format), but log the failure
          console.error(`[ERR][WALLET] vault_migration_failed from_version=${fromVersion} err=${migrationError.message}`);
          // Re-throw so caller can show an error to user
          throw new Error(`Wallet migration failed: ${migrationError.message}. Your wallet data is safe — please try again.`);
        }
      } else {
        // Cache CryptoKey for faster subsequent unlocks (skip if already cached by verifyPassword)
        if (!this.keyCache) {
          const k = await this._deriveKeyNative(password, vaultData.salt, WalletManager.VAULT_ITERATIONS_V3);
          this._setCachedKey(k, vaultData.salt, WalletManager.VAULT_ITERATIONS_V3);
        }
      }

      if (wallet.qnetAddress) {
        await AsyncStorage.setItem('qnet_address', wallet.qnetAddress);
        // Stamp the crypto scheme so getCurrentWallet (no-password path) never trusts an
        // address cached by the old round-3 build; a missing/old stamp = re-derive on unlock.
        await AsyncStorage.setItem('qnet_address_scheme', 'fips204');
      }

      // Remove mnemonic from returned object — caller uses getEncryptedMnemonic() explicitly
      if (wallet.mnemonic) delete wallet.mnemonic;

      // Attach migration info for caller to show notification
      wallet._migrated = migrated;
      wallet._migratedFromVersion = migrated ? fromVersion : null;
      return wallet;
    } catch (error) {
      throw error;
    }
  }

  // Get wallet balance from Solana network
  async getBalance(publicKey, isTestnet = true) {
    // 2 attempts, rotating the Solana RPC endpoint on 429/failure; null (not 0) ⇒ keep last-known.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rpcUrl = attempt === 0 ? getSolanaRpcUrl(isTestnet) : rotateSolanaRpc(isTestnet);
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [publicKey] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(t));
        if (response.ok) {
          const data = await response.json();
          return (data.result?.value || 0) / 1e9; // lamports → SOL
        }
      } catch (error) { /* rotate + retry */ }
    }
    return null;
  }
  
  // Get SPL token balance (for 1DEV and other tokens)
  async getTokenBalance(walletAddress, mintAddress, isTestnet = true) {
    // 2 attempts, rotating the Solana RPC on 429/failure; null (not 0) on failure ⇒ keep last-known.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rpcUrl = attempt === 0 ? getSolanaRpcUrl(isTestnet) : rotateSolanaRpc(isTestnet);
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
            params: [walletAddress, { mint: mintAddress }, { encoding: 'jsonParsed' }] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(t));
        if (response.ok) {
          const data = await response.json();
          const accounts = data.result?.value || [];
          if (accounts.length > 0) {
            return parseFloat(accounts[0].account.data.parsed.info.tokenAmount.uiAmount) || 0;
          }
          return 0; // no token account = genuine zero
        }
      } catch (error) { /* rotate + retry */ }
    }
    return null;
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
  // Returns { ok, balance, verified, ... }. ok=false ⇒ fetch failed / no data: the caller MUST keep
  // the last-known balance, NEVER display a fabricated 0. Hedged + health-ranked (send-path bar).
  async getQNCBalanceWithProof(address, verify = true, _maxRetries = 3) {
    if (!address || typeof address !== 'string') {
      return { ok: false, balance: null, verified: false, error: 'Invalid address' };
    }
    let res;
    try {
      // raw text: balance/nonce are uint64 — JSON.parse would lose precision past 2^53 nano (>9.007M QNC).
      res = await this._hedged(`/api/v1/account/${address}/balance/proof`, { timeoutMs: 5000, hedgeMs: 800, raw: true });
    } catch (e) {
      console.warn('[BALANCE] proof fetch failed:', e.message);
      return { ok: false, balance: null, verified: false, error: e.message };
    }
    if (!res.ok || !res.data) {
      return { ok: false, balance: null, verified: false, error: `HTTP ${res.status}` };
    }
    let data;
    try { data = JSON.parse(res.data); } catch (_) {
      return { ok: false, balance: null, verified: false, error: 'bad json' };
    }
    // Exact base-units extracted as strings from the raw text (BigInt-safe for the proof); Number only
    // for the display value, where precision loss above ~9M QNC is acceptable.
    const balMatch = /"balance"\s*:\s*"?(\d+)"?/.exec(res.data);
    const balanceNanoStr = balMatch ? balMatch[1] : String(data.balance || 0);
    const nonceMatch = /"nonce"\s*:\s*"?(\d+)"?/.exec(res.data);
    const nonceStr = nonceMatch ? nonceMatch[1] : String(data.nonce || 0);
    // pending_rewards is in the account leaf, so the proof needs it (0 for a fresh wallet).
    const pendMatch = /"pending_rewards"\s*:\s*"?(\d+)"?/.exec(res.data);
    const pendingStr = pendMatch ? pendMatch[1] : '0';
    const balanceQNC = Number(balanceNanoStr) / 1e9;
    // QC-anchored proof verification (MITM-proof); advisory flag surfaced to the caller.
    let verified = false;
    if (verify && data.merkle_proof && data.merkle_proof.length > 0) {
      const proofValid = await this.verifyMerkleProof(address, balanceNanoStr, nonceStr, data.merkle_proof, data.state_root, pendingStr);
      if (proofValid) {
        verified = await verifyMacroblockStateRoot(data.state_root, data.block_height, () => this.getRankedNodes(1)[0]);
      }
    }
    return {
      ok: true, balance: balanceQNC, balanceNano: balanceNanoStr, nonce: nonceStr,
      verified, blockHeight: data.block_height, stateRoot: data.state_root, proof: data.merkle_proof,
    };
  }

  // V2: TRUSTLESS QRC-20 balance — exactly the getQNCBalanceWithProof trust model, one level deeper.
  //   GET /api/v1/token/{contract}/{holder}/balance/proof -> two-level TokenBalanceProof.
  // verifyTokenBalanceProof re-derives the chain balance -> storage_root -> contract account leaf ->
  // state_root; then verifyMacroblockStateRoot independently anchors state_root to the committee QC
  // (MITM-proof). `verified` is true only if BOTH hold. Balance is exact u64-string (BigInt-safe).
  async getTokenBalanceWithProof(contract, holder, decimals = null, verify = true) {
    if (!contract || !holder) return { ok: false, balance: null, verified: false, error: 'bad args' };
    let res;
    try {
      res = await this._hedged(`/api/v1/token/${contract}/${holder}/balance/proof`, { timeoutMs: 5000, hedgeMs: 800, raw: true });
    } catch (e) {
      return { ok: false, balance: null, verified: false, error: e.message };
    }
    if (!res.ok || !res.data) return { ok: false, balance: null, verified: false, error: `HTTP ${res.status}` };
    let data;
    try { data = JSON.parse(res.data); } catch (_) { return { ok: false, balance: null, verified: false, error: 'bad json' }; }
    // token_balance is a u64 base-unit string — re-extract from raw text so it stays exact past 2^53.
    const balMatch = /"token_balance"\s*:\s*"?(\d+)"?/.exec(res.data);
    const baseUnitsStr = balMatch ? balMatch[1] : String(data.token_balance || '0');
    let verified = false;
    if (verify && Array.isArray(data.storage_proof) && Array.isArray(data.account_proof)) {
      // SECURITY: bind to the REQUESTED (contract, holder) — else a valid proof for a DIFFERENT
      // token/holder verifies internally and falsely earns the checkmark.
      const proofValid = await this.verifyTokenBalanceProof(data, contract, holder);
      if (proofValid) {
        verified = await verifyMacroblockStateRoot(data.state_root, data.block_height, () => this.getRankedNodes(1)[0]);
      }
    }
    const human = decimals != null ? this._formatBaseUnits(baseUnitsStr, decimals) : baseUnitsStr;
    return {
      ok: true, balance: human, balanceBase: baseUnitsStr, verified,
      blockHeight: data.block_height, stateRoot: data.state_root,
    };
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
      console.warn('[QRC20] holdings fetch failed:', e.message);
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
      };
    }).filter((t) => t.contract);
  }

  // Token metadata for a contract.
  //   GET /api/v1/token/{addr} -> {name, symbol, decimals, total_supply, deployer}
  // Returns {contract, name, symbol, decimals, totalSupply, deployer} or null when the contract
  // is not a token / not found (so the Add-Token flow can reject an invalid address honestly).
  async getTokenInfo(contractAddress) {
    if (!contractAddress || typeof contractAddress !== 'string') return null;
    let res;
    try {
      res = await this._hedged(`/api/v1/token/${contractAddress}`, { timeoutMs: 5000, hedgeMs: 800 });
    } catch (e) {
      console.warn('[QRC20] token info fetch failed:', e.message);
      return null;
    }
    if (!res.ok || !res.data || typeof res.data !== 'object') return null;
    const d = res.data;
    // A miss returns an error body or an empty object — require the token identity fields.
    if (d.error || (d.symbol == null && d.name == null)) return null;
    return {
      contract: contractAddress,
      name: d.name || d.symbol || 'Token',
      symbol: d.symbol || '',
      // Defensive across a flat or {token:{...}}-nested body; '' ⇒ client renders a generated avatar.
      logo: String((d.logo != null ? d.logo : (d.token && d.token.logo)) || ''),
      decimals: Number(d.decimals) || 0,
      totalSupply: d.total_supply != null ? String(d.total_supply) : null,
      deployer: d.deployer || null,
    };
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
      console.warn('[QRC20] token transfers fetch failed:', e.message);
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
    const anchored = await verifyMacroblockLogsRoot(d.logs_root, d.window_end, () => this.getRandomBootstrapNode());
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
      console.warn('[QRC20] token balance fetch failed:', e.message);
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
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid token amount');
    let [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > d) throw new Error(`Amount has more than ${d} decimal places`);
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
    if (!Array.isArray(proof)) return false;
    let current = leafHashHex;
    for (let i = 0; i < proof.length; i++) {
      const isRight = proof[i].is_right;
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      const kByte = byteIdx < 32 ? parseInt(keyHashHex.substring(byteIdx * 2, byteIdx * 2 + 2), 16) : 0;
      const expectedBit = ((kByte >> bitIdx) & 1) === 1;
      if (isRight !== expectedBit) return false;
      const sib = this.hexToBytes(proof[i].sibling);
      const cur = this.hexToBytes(current);
      const combined = isRight ? this.concatBytes(sib, cur) : this.concatBytes(cur, sib);
      current = sha3_256(combined);
    }
    return current === root;
  }

  async verifyMerkleProof(address, balance, nonce, proof, expectedRoot, pending = 0) {
    try {
      // Import js-sha3 for SHA3-256 (same as Rust implementation)
      const { sha3_256 } = await import('js-sha3');

      // Hash address (same as Rust: b"QNET_ADDR:" + address.as_bytes())
      const addrHashHex = sha3_256(this.concatBytes(
        Buffer.from('QNET_ADDR:', 'utf8'),
        Buffer.from(address, 'utf8')
      ));

      // Account leaf — MUST match Rust hash_account (QNET_ACCOUNT_V2) EXACTLY, else the leaf
      // never matches the QC-committed root and the proof always fails. A plain wallet has
      // is_contract=false, no code/storage, and (server proof leaf) heartbeat/last_claimed=0;
      // pending_rewards is threaded from the account. Field order + widths are byte-exact.
      const accountDataBytes = this.concatBytes(
        Buffer.from('QNET_ACCOUNT_V2:', 'utf8'),
        this.uint64ToBytes(balance),           // balance u64 LE
        this.uint64ToBytes(nonce),             // nonce u64 LE
        Buffer.from(address, 'utf8'),          // address string bytes
        Buffer.from([0]),                      // is_contract = false
        this.uint64ToBytes(pending),           // pending_rewards u64 LE
        Buffer.from('HB:', 'utf8'),
        this.uint64ToBytes(0),                 // heartbeat_epoch u64 LE
        Buffer.from([0, 0]),                   // heartbeat_slots u16 LE
        this.uint64ToBytes(0),                 // heartbeat_final_epoch u64 LE
        Buffer.from([0]),                      // heartbeat_final_count u8
        Buffer.from('LCE:', 'utf8'),
        this.uint64ToBytes(0)                  // last_claimed_epoch u64 LE
      );
      const leafHash = sha3_256(accountDataBytes);
      // Fold the account leaf up to the expected root via the shared SMT primitive.
      return this._smtFold(leafHash, addrHashHex, proof, expectedRoot, sha3_256);
    } catch (error) {
      console.warn('[MERKLE] Proof verification failed:', error.message);
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
        account_balance, account_nonce, account_pending_rewards,
        contract_code_hash, heartbeat_epoch, heartbeat_slots,
        heartbeat_final_epoch, heartbeat_final_count, last_claimed_epoch,
        state_root,
      } = proofData;

      // Identity binding: the folds below verify against the identifiers IN the proof, so reject unless
      // they match what we requested (else a valid proof for another token/holder passes).
      if (expectedContract != null && contract_address !== expectedContract) return false;
      if (expectedHolder != null && holder !== expectedHolder) return false;

      // The proof's own state_root MUST equal the root we independently trust (QC-verified).
      if (expectedStateRoot && state_root !== expectedStateRoot) return false;

      // Both levels are canonical 256-deep SMT proofs; fold each with the ONE shared primitive.
      if (!Array.isArray(storage_proof) || storage_proof.length !== 256) return false;
      if (!Array.isArray(account_proof) || account_proof.length !== 256) return false;

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
      parts.push(this.uint64ToBytes(account_pending_rewards));
      parts.push(Buffer.from('HB:', 'utf8'));
      parts.push(this.uint64ToBytes(heartbeat_epoch || 0));
      const slots = heartbeat_slots || 0;
      parts.push(Buffer.from([slots & 0xff, (slots >> 8) & 0xff])); // u16 LE
      parts.push(this.uint64ToBytes(heartbeat_final_epoch || 0));
      parts.push(Buffer.from([(heartbeat_final_count || 0) & 0xff]));
      parts.push(Buffer.from('LCE:', 'utf8'));
      parts.push(this.uint64ToBytes(last_claimed_epoch || 0));
      const contractLeafHex = sha3_256(this.concatBytes(...parts));
      if (!this._smtFold(contractLeafHex, contractAddrHashHex, account_proof, state_root, sha3_256)) return false;

      return true;
    } catch (error) {
      console.warn('[MERKLE] Token proof verification failed:', error.message);
      return false;
    }
  }

  /**
   * v3.32: Verify validator set proof locally
   * TRUSTLESS verification - matches Rust implementation exactly
   */
  async verifyValidatorSetProof(proofData) {
    try {
      const { sha3_256 } = await import('js-sha3');
      
      const validators = proofData.validators || [];
      const epoch = proofData.epoch || 0;
      const expectedRoot = proofData.merkle_root;
      
      if (!expectedRoot) return false;
      
      // Sort validators by node_id for deterministic ordering (same as Rust)
      const sorted = [...validators].sort((a, b) => 
        (a.node_id || '').localeCompare(b.node_id || '')
      );
      
      // Build hash (same as Rust: b"QNET_VALIDATOR_SET:" + epoch + validators)
      let dataToHash = this.concatBytes(
        Buffer.from('QNET_VALIDATOR_SET:', 'utf8'),
        this.uint64ToBytes(epoch)
      );
      
      for (const v of sorted) {
        dataToHash = this.concatBytes(
          dataToHash,
          Buffer.from(v.node_id || '', 'utf8'),
          Buffer.from(v.address || '', 'utf8'),
          Buffer.from(v.node_type || '', 'utf8'),
          this.float64ToBytes(v.reputation || 0),
          this.uint64ToBytes(v.last_seen || 0),
          new Uint8Array([v.is_active ? 1 : 0])
        );
      }
      
      const computedRoot = sha3_256(dataToHash);
      return computedRoot === expectedRoot;
    } catch (error) {
      console.warn('[DISCOVERY] Validator set proof verification failed:', error.message);
      return false;
    }
  }

  // Helper: Convert float64 to bytes (little-endian, for reputation)
  float64ToBytes(value) {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, value, true); // little-endian
    return new Uint8Array(buffer);
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

  /**
   * DEPRECATED + UNUSED (kept for reference). Superseded by the trustless
   * committee-QC light client: QcLightClient.verifyMacroblockStateRoot().
   *
   * SECURITY: this 2/3 multi-node poll is MITM-bypassable — an attacker on the
   * path (or controlling the polled subset) can return matching FAKE state_roots
   * and pass the vote. It verifies agreement, not authenticity. The replacement
   * verifies a ≥quorum post-quantum committee QC inductively from a pinned anchor,
   * so a forged root cannot be certified without breaking ML-DSA-65 / SHA3.
   *
   * No remaining callers. Safe to delete in a later cleanup.
   */
  async verifyStateRootFromMultipleNodes(stateRoot, blockHeight) {
    try {
      // v3.12: Get nodes from discovery system (NOT hardcoded!)
      // This distributes load across ALL active nodes in the network
      const nodes = await this.getNodesForVerification();
      
      if (nodes.length < 2) {
        // Not enough nodes for consensus verification
        console.warn('[MERKLE] Not enough nodes for verification:', nodes.length);
        return false;
      }
      
      // v3.11: state_root is in MacroBlock
      // MacroBlock index = floor(blockHeight / 90)
      const macroBlockIndex = Math.floor(blockHeight / 90);
      
      // Query state_root from multiple nodes in parallel (max 5 to limit load)
      const nodesToQuery = nodes.slice(0, 5);
      const queries = nodesToQuery.map(async (nodeUrl) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          
          // v3.11: Use macroblock endpoint for state_root
          const response = await fetch(`${nodeUrl}/api/v1/macroblock/${macroBlockIndex}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) return null;
          
          const macroblock = await response.json();
          return macroblock.state_root || null;
        } catch {
          return null;
        }
      });
      
      const results = await Promise.all(queries);
      const validResults = results.filter(r => r !== null);
      
      if (validResults.length < 2) {
        return false; // Not enough responses
      }
      
      // Count how many nodes agree on the state_root
      const matchCount = validResults.filter(r => r === stateRoot).length;
      const threshold = Math.ceil(validResults.length * 2 / 3); // 2/3 consensus
      
      return matchCount >= threshold;
    } catch (error) {
      console.warn('[MERKLE] State root verification failed:', error.message);
      return false;
    }
  }

  /**
   * v3.36: Get nodes for verification using WEIGHTED RANDOM sampling
   * 
   * CRITICAL: NOT TOP 20! Uses ALL eligible nodes with weighted random selection
   * This distributes load across ALL nodes in the network (100K+ scalability)
   * 
   * TOP L1 pattern:
   * - Solana: random sampling from active validators
   * - Ethereum light clients: random peer selection
   * - Cosmos: weighted random by stake
   * 
   * Our algorithm:
   * 1. Filter: rep >= 70%, lastSeen < 5 min, isSynced
   * 2. Weighted random selection (5 nodes) - higher rep = higher chance
   * 3. Load distributed across ALL eligible nodes
   */
  async getNodesForVerification() {
    try {
      // v3.35: Cache contains ALL validators (Genesis + Super) from Merkle-verified list
      const cachedNodes = await AsyncStorage.getItem('qnet_discovered_nodes');
      if (cachedNodes) {
        const nodes = JSON.parse(cachedNodes);
        const currentTime = Math.floor(Date.now() / 1000);
        
        // v3.35: STRICT filters - same as discovery
        // - last_seen < 5 minutes (300 sec) from P2P heartbeat
        // - reputation >= 70% from blockchain
        // - is_synced = true (not more than 5 blocks behind)
        const eligibleNodes = nodes.filter(node => {
          const age = currentTime - (node.lastSeen || 0);
          return age < NODE_DISCOVERY.MAX_STALE_SECS && 
                 (node.reputation || 0) >= NODE_DISCOVERY.MIN_REPUTATION &&
                 node.isSynced !== false;
        });
        
        if (eligibleNodes.length >= 2) {
          // v3.36: WEIGHTED RANDOM from ALL eligible nodes (not TOP 20!)
          // This distributes load across 100K+ nodes proportionally
          const selectedNodes = this.weightedRandomSample(eligibleNodes, 5);
          return selectedNodes.map(n => n.url);
        }
      }
    } catch (e) {
      // Cache error
    }
    
    // FIRST LAUNCH ONLY - cache is empty
    // Triggers discovery which will populate cache (includes Genesis)
    this.refreshNodeDiscovery();
    
    // Bootstrap: use Genesis nodes for first verification
    // After discovery completes, cache will have all validators
    return GENESIS_NODES.map(url => url);
  }
  
  /**
   * v3.36: Weighted random sampling WITHOUT replacement
   * Higher reputation = higher probability of being selected
   * Used for multi-node verification (Byzantine fault tolerance)
   * 
   * Algorithm: Reservoir sampling with weights
   * - Each node has weight = reputation
   * - Select N nodes with probability proportional to weight
   * - No duplicates (without replacement)
   * 
   * @param {Array} nodes - Array of nodes with reputation field
   * @param {number} count - Number of nodes to select
   * @returns {Array} Selected nodes (up to count)
   */
  weightedRandomSample(nodes, count) {
    if (nodes.length <= count) {
      return this.shuffleArray([...nodes]);
    }
    
    const selected = [];
    const available = [...nodes]; // Copy to avoid mutation
    
    for (let i = 0; i < count && available.length > 0; i++) {
      // Calculate total weight of remaining nodes
      const totalWeight = available.reduce((sum, n) => sum + (n.reputation || 0.7), 0);
      
      // Random value in [0, totalWeight)
      let random = Math.random() * totalWeight;
      
      // Select node based on weight
      let selectedIdx = 0;
      for (let j = 0; j < available.length; j++) {
        random -= (available[j].reputation || 0.7);
        if (random <= 0) {
          selectedIdx = j;
          break;
        }
      }
      
      // Move selected node to result
      selected.push(available[selectedIdx]);
      available.splice(selectedIdx, 1); // Remove from pool (no replacement)
    }
    
    return selected;
  }

  /**
   * v3.13: Discover high-reputation nodes from network
   * Queries /api/v1/peers and saves nodes with reputation >= 70%
   */
  async discoverHighRepNodes(seedNodeUrl) {
    const MIN_REPUTATION = 0.70;
    
    try {
      const response = await fetch(`${seedNodeUrl}/api/v1/peers`, {
        method: 'GET',
        timeout: 5000
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.peers && Array.isArray(data.peers)) {
          // Filter by high reputation
          const highRepNodes = data.peers
            .filter(peer => 
              peer.address && 
              (peer.reputation || 0) >= MIN_REPUTATION
            )
            .map(peer => ({
              url: peer.address.startsWith('http') ? peer.address : `http://${peer.address}`,
              reputation: peer.reputation,
              nodeType: peer.node_type,
              lastSeen: Date.now()
            }));
          
          if (highRepNodes.length > 0) {
            // Merge with existing cache
            let allNodes = highRepNodes;
            try {
              const cached = await AsyncStorage.getItem('qnet_discovered_nodes');
              if (cached) {
                const existing = JSON.parse(cached);
                // Merge, preferring new data
                const urlMap = {};
                existing.forEach(n => urlMap[n.url] = n);
                highRepNodes.forEach(n => urlMap[n.url] = n);
                allNodes = Object.values(urlMap);
              }
            } catch (e) {}
            
            await AsyncStorage.setItem('qnet_discovered_nodes', JSON.stringify(allNodes));
            console.log(`[MERKLE] Discovered ${highRepNodes.length} high-rep nodes`);
          }
        }
      }
    } catch (e) {
      // Discovery failed silently
    }
  }

  // Helper: Shuffle array (Fisher-Yates)
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
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


  // CACHE: Network size (avoid spamming bootstrap nodes)
  _networkSizeCache = null;
  _networkSizeCacheTime = 0;
  static NETWORK_SIZE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  
  // Get active nodes count from blockchain/API
  // PRODUCTION: Real API call with caching to reduce load
  async getActiveNodesCount(isTestnet = true) {
    // CHECK CACHE FIRST
    const now = Date.now();
    if (this._networkSizeCache !== null && 
        (now - this._networkSizeCacheTime) < WalletManager.NETWORK_SIZE_CACHE_TTL) {
      console.log(`[PRICING] 📦 Using cached network size: ${this._networkSizeCache}`);
      return this._networkSizeCache;
    }
    
    // Canonical Genesis list (single source: config/nodes.js).
    const bootstrapNodes = GENESIS_NODES;

    // Try multiple bootstrap nodes for reliability
    for (const apiUrl of bootstrapNodes) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(`${apiUrl}/api/v1/network/stats`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const stats = await response.json();
          // Return total active nodes (Light + Super)
          const totalNodes = (stats.light_nodes || 0) + 
                            (stats.super_nodes || 0);
          if (totalNodes > 0) {
            // UPDATE CACHE
            this._networkSizeCache = totalNodes;
            this._networkSizeCacheTime = now;
            console.log(`[PRICING] 📊 Network size fetched: ${totalNodes} (cached for 5 min)`);
            return totalNodes;
          }
        }
      } catch (nodeError) {
        // Try next node
        continue;
      }
    }
    
    // All nodes failed - throw error, NOT fake data
    console.warn('[PRICING] Could not reach any bootstrap nodes');
    throw new Error('Network size unavailable - all bootstrap nodes unreachable');
  }

  // Get real burn progress from blockchain
  async getBurnProgress(isTestnet = true) {
    try {
      // v4.10: Centralized RPC URL
      const rpcUrl = getSolanaRpcUrl(isTestnet);
      
      // 1DEV token mint addresses - ensure correct assignment
      const oneDevMint = isTestnet 
        ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'  // Testnet 1DEV
        : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';  // Mainnet 1DEV
      
      const TOTAL_SUPPLY = 1000000000; // 1 billion total supply
      
      // Try to get current supply and calculate burned amount
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenSupply',
            params: [oneDevMint]
          })
        });
      } finally {
        clearTimeout(timeoutId);
      }
      
      if (response.ok) {
        const data = await response.json();
        
        if (data.result && data.result.value) {
          const currentSupply = parseFloat(data.result.value.amount) / Math.pow(10, data.result.value.decimals || 6);
          const burnedAmount = TOTAL_SUPPLY - currentSupply;
          
          // Only return if we have a reasonable burned amount
          if (burnedAmount > 0 && burnedAmount < TOTAL_SUPPLY) {
            const burnPercentage = (burnedAmount / TOTAL_SUPPLY * 100);
            // Show more precision for small percentages
            if (burnPercentage < 0.01) {
              const result = burnPercentage.toFixed(4);
              return result;
            } else if (burnPercentage < 1) {
              const result = burnPercentage.toFixed(3);
              return result;
            } else {
              const result = burnPercentage.toFixed(1);
              return result;
            }
          }
        }
      } else {
        // console.error('[getBurnProgress] Failed to fetch:', response.status, response.statusText);
      }
      
      return null; // failure ⇒ caller keeps last-known (don't fabricate 0.0%)
    } catch (error) {
      return null;
    }
  }

  // Burn tokens for node activation (real implementation)
  async burnTokensForNode(nodeType, amount = null, isTestnet = false, password) {
    try {
      const web3 = require('@solana/web3.js');
      const { Transaction, SystemProgram, Connection, Keypair, PublicKey } = web3;
      const { createBurnInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
      
      // Calculate dynamic amount if not provided
      if (!amount) {
        const pricing = await this.calculateActivationCost(nodeType);
        if (pricing.phase === 2) {
          throw new Error('Phase 2 activated: QNC required for activation, not 1DEV');
        }
        amount = pricing.cost;
      }
      
      const connection = new Connection(getSolanaRpcUrl(isTestnet), 'confirmed');
      
      // Load and decrypt wallet properly
      if (!password) {
        throw new Error('Password required for burning tokens');
      }
      
      const wallet = await this.loadWallet(password);
      
      if (!wallet.secretKey) {
        throw new Error('Secret key not found');
      }
      
      // Create keypair from secret key
      const keypair = Keypair.fromSecretKey(new Uint8Array(wallet.secretKey));
      
      // Token mint address for 1DEV
      const tokenMint = new PublicKey(
        isTestnet 
          ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ' // Devnet
          : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump' // Mainnet
      );
      
      // Get associated token address
      const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        keypair.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      // Check token balance
      const tokenAccountInfo = await connection.getTokenAccountBalance(tokenAccount);
      if (!tokenAccountInfo || !tokenAccountInfo.value) {
        throw new Error('No 1DEV token account found');
      }
      
      const tokenBalance = tokenAccountInfo.value.uiAmount || 0;
      if (tokenBalance < amount) {
        throw new Error(`Insufficient 1DEV balance: ${tokenBalance}, required: ${amount}`);
      }
      
      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
      
      // Create burn instruction
      const burnAmount = amount * Math.pow(10, 6); // Convert to lamports (6 decimals for 1DEV)
      const burnInstruction = createBurnInstruction(
        tokenAccount,      // Token account to burn from
        tokenMint,         // Token mint
        keypair.publicKey, // Owner
        burnAmount,        // Amount to burn
        [],                // Multisingers (empty)
        TOKEN_PROGRAM_ID   // Token program
      );
      
      // Create MEMO instruction with node type
      // This will be permanently stored on blockchain for sync
      const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      const memoData = `QNET_NODE_TYPE:${nodeType.toUpperCase()}`;
      const memoInstruction = {
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoData, 'utf-8')
      };
      
      // Create and send transaction with BOTH instructions
      const transaction = new Transaction()
        .add(burnInstruction)
        .add(memoInstruction);  // Add memo after burn
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = keypair.publicKey;
      
      // Sign transaction
      transaction.sign(keypair);
      
      // Send transaction (skip preflight for speed - balance already checked)
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        preflightCommitment: 'processed'
      });
      
      // Wait for confirmation with timeout (30 seconds max)
      const confirmPromise = connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('TIMEOUT')), 30000)
      );
      
      let confirmation;
      try {
        confirmation = await Promise.race([confirmPromise, timeoutPromise]);
      } catch (timeoutErr) {
        if (timeoutErr.message === 'TIMEOUT') {
          // Transaction was sent but confirmation timed out
          // Return signature anyway - tx is likely already on chain
          console.log('Confirmation timed out, but transaction was sent:', signature);
          return {
            nodeType,
            amount,
            timestamp: Date.now(),
            signature: signature,
            txHash: signature,
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=${isTestnet ? 'devnet' : 'mainnet-beta'}`
          };
        }
        throw timeoutErr;
      }
      
      if (!confirmation.value.err) {
        // Transaction successful
        return {
        nodeType,
        amount,
        timestamp: Date.now(),
          signature: signature,  // Add signature field
          txHash: signature,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=${isTestnet ? 'devnet' : 'mainnet-beta'}`
        };
      } else {
        throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
      }
    } catch (error) {
      // console.error('Error burning tokens:', error);
      throw error;
    }
  }
  
  // REQUEST activation code from server after burn verification
  // CRITICAL: Codes are ONLY generated server-side after verifying burn transaction!
  // Mobile app does NOT generate codes - it receives them from server
  // 
  // Phase 1: Burn 1DEV on Solana → Server verifies → Server generates code
  // Phase 2: Transfer QNC to Pool 3 → Server verifies → Server generates code
  //
  // This method is DEPRECATED - use requestActivationCodeFromServer() instead
  // Kept for backward compatibility with stored codes only
  // Default to 'super' for backward compatibility
  generateActivationCode(nodeType = 'super', walletAddress = '', seedPhrase = null) {
    console.warn('[DEPRECATED] generateActivationCode() should not be used for new activations');
    console.warn('   Use requestActivationCodeFromServer() after burn transaction');
    
    // For backward compatibility with existing stored codes only
    // New activations MUST go through server
    if (!walletAddress) {
      throw new Error('Wallet address required');
    }
    
    // Generate deterministic preview code (NOT valid for activation)
    // This is only for display purposes until server provides real code
    const seedData = seedPhrase 
      ? `${seedPhrase}-${nodeType}-QNET_ACTIVATION_V2`
      : `${nodeType}-${walletAddress}-activation`;
    const entropy = CryptoJS.SHA256(seedData).toString(CryptoJS.enc.Hex);
    
    const entropyUpper = entropy.toUpperCase();
    const segment1 = entropyUpper.substring(0, 6);
    const segment2 = entropyUpper.substring(6, 12);
    const segment3 = entropyUpper.substring(12, 18);
    
    // PREVIEW code - NOT valid for actual activation
    return `QNET-${segment1}-${segment2}-${segment3}`;
  }
  
  // Request activation code from server after burn verification
  // Phase 1: burnTxHash = Solana 1DEV burn transaction, qnetRewardWallet = EON address for rewards
  // Phase 2: burnTxHash = QNet QNC transfer to Pool 3 transaction
  // ============================================================================
  // LOCAL activation code generation — NO server dependency.
  // Identical algorithm to server-side generate_quantum_activation_code (rpc.rs).
  // Inputs are all derivable from Solana blockchain → always reproducible.
  //
  // Algorithm:
  //   key      = SHA3_256("burn_tx:type:amount")[0:32]
  //   seg1     = type_marker + SHA3_256("ts:burn_tx:type")[0:5]    (6 chars)
  //   seg2     = hex(XOR(wallet_bytes, key))[0:6]                   (6 chars)
  //   seg3     = (hex(XOR(wallet_bytes, key))[6:10]
  //              + SHA3_256("entropy:wallet:burn_tx:type")[0:4])[0:6] (6 chars)
  //   code     = QNET-{seg1}-{seg2}-{seg3}
  // ============================================================================
  generateActivationCodeLocally(nodeType, walletAddress, burnTxHash, burnAmount) {
    const sha3_256 = require('js-sha3').sha3_256;
    const type = nodeType.toLowerCase();

    // Step 1: XOR encryption key = SHA3("burn_tx:type:amount")[0:32]
    const keyFull = sha3_256(`${burnTxHash}:${type}:${burnAmount}`); // 64 hex chars
    const encKey = keyFull.substring(0, 32); // 32 hex chars → used as byte key

    // Step 2: XOR encrypt wallet address bytes (cycling over key)
    const walletBytes = Array.from(walletAddress).map(c => c.charCodeAt(0));
    const keyBytes   = Array.from(encKey).map(c => c.charCodeAt(0));
    const encBytes   = walletBytes.map((b, i) => b ^ keyBytes[i % keyBytes.length]);
    const encHex     = encBytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

    // Step 3: segment1 — type marker + SHA3("ts:burn_tx:type")[0:5]
    const marker     = type === 'super' ? 'S' : 'L';
    const tsHash     = sha3_256(`ts:${burnTxHash}:${type}`);
    const tsPart     = tsHash.substring(0, 5).toUpperCase();
    const segment1   = `${marker}${tsPart}`;                // 6 chars

    // Step 4: segment2 — first 6 hex chars of encrypted wallet
    const segment2   = (encHex + '000000').substring(0, 6); // 6 chars

    // Step 5: segment3 — next 4 hex chars + entropy[0:4], take first 6
    const walletPart2 = (encHex.substring(6, 10) + '0000').substring(0, 4);
    const entropy     = sha3_256(`entropy:${walletAddress}:${burnTxHash}:${type}`);
    const entShort    = entropy.substring(0, 4).toUpperCase();
    const segment3    = (walletPart2 + entShort).substring(0, 6); // 6 chars

    const code = `QNET-${segment1}-${segment2}-${segment3}`;
    console.log(`[LOCAL_CODE] Generated: ${code.substring(0, 12)}... type=${type} tx=${burnTxHash.substring(0, 8)}...`);
    return code;
  }

  // CRITICAL: actualBurnAmount MUST be the exact amount burned on Solana — NOT the current price!
  //   XOR key = SHA3(burn_tx:type:amount) — if amount is wrong, code can NEVER be verified.
  //   Caller must pass the same amount used in burnTokensForNode / burnTokens.
  async requestActivationCodeFromServer(nodeType, walletAddress, burnTxHash, phase = 1, qnetRewardWallet = null, actualBurnAmount = null) {
    try {
      const apiUrl = this.getRandomBootstrapNode();
      
      // Use ACTUAL burned amount (from caller) — NOT current price!
      // XOR key = SHA3(burn_tx:type:amount) — amount MUST match exactly what was burned
      // Dynamic pricing: amount varies based on network burn percentage — NO hardcoded defaults
      let burnAmount = actualBurnAmount;
      if (!burnAmount || burnAmount <= 0) {
        // Fallback: fetch DYNAMIC price from server (correct endpoint: /api/v1/activation/price)
        // This uses GLOBAL_BURN_PERCENTAGE on server — the actual current network price
        console.warn('[WalletManager] actualBurnAmount not provided — fetching dynamic price from server');
        try {
          const pricingResponse = await fetch(`${apiUrl}/api/v1/activation/price?type=${nodeType}`);
          const pricing = await pricingResponse.json();
          burnAmount = pricing.cost || 0; // Server returns "cost" field, NOT "current_price"
        } catch (pricingErr) {
          console.warn('[WalletManager] Pricing fetch failed:', pricingErr.message);
        }
        if (!burnAmount || burnAmount <= 0) {
          throw new Error('Cannot determine burn amount — dynamic pricing requires server or caller to provide actual amount');
        }
      }
      
      // Build request body
      const requestBody = {
        wallet_address: walletAddress,
        burn_tx_hash: burnTxHash,
        node_type: nodeType,
        burn_amount: burnAmount,
        phase: phase
      };
      
      // Phase 1 requires QNet EON address for rewards (separate from Solana burn address)
      if (phase === 1 && qnetRewardWallet) {
        requestBody.qnet_reward_wallet = qnetRewardWallet;
      }
      
      // Request code generation from server
      const response = await fetch(`${apiUrl}/api/v1/generate-activation-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      
      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.error || 'Failed to generate activation code');
      }
      
      return {
        success: true,
        activationCode: result.activation_code,
        walletAddress: result.wallet_address,
        nodeType: result.node_type,
        phase: result.phase,
        burnTxHash: burnTxHash
      };
    } catch (error) {
      console.warn('[WalletManager] Activation code request failed:', error.message || error);
      throw error;
    }
  }
  
  /**
   * Verify that a node activation exists on the CURRENT QNet blockchain.
   * Prevents stale local cache from showing phantom activations after network restart.
   * Checks: RocksDB storage, genesis constants, reward manager, and blockchain scan.
   * @param {string} walletAddress - QNet EON or Solana wallet address
   * @returns {{ verified: boolean, node_type?: string, node_id?: string, source?: string }}
   */
  async verifyActivationOnChain(walletAddress) {
    try {
      const apiUrl = this.getRandomBootstrapNode();
      // Wallet via header, not the URL (privacy).
      const response = await fetch(
        `${apiUrl}/api/v1/verify-activation`,
        { method: 'GET', headers: { 'Content-Type': 'application/json', 'X-QNet-Wallet': walletAddress } }
      );

      if (!response.ok) {
        console.warn('[verifyOnChain] Server returned', response.status);
        return { verified: false, error: `HTTP ${response.status}` };
      }

      const result = await response.json();
      console.log('[verifyOnChain] Result:', JSON.stringify(result));
      return result;
    } catch (error) {
      console.warn('[verifyOnChain] Verification request failed:', error.message);
      // Network error — do NOT invalidate cache (could be temporary connectivity issue)
      return { verified: false, error: error.message, networkError: true };
    }
  }

  // Encrypt and store activation code securely
  async storeActivationCode(code, nodeType, password, metadata = {}) {
    try {
      // Get existing encrypted codes or initialize
      const existingCodesStr = await AsyncStorage.getItem('qnet_activation_codes');
      let encryptedCodes = existingCodesStr ? JSON.parse(existingCodesStr) : {};
      
      // Store activation metadata (timestamp, tx signature, phase, wallet address, burn amount)
      // CRITICAL: phase determines which wallet address to use for claims
      // Phase 1: Solana address, Phase 2: QNet address
      // burnAmount is REQUIRED for stateless XOR verification on server nodes
      await AsyncStorage.setItem(`qnet_activation_meta_${nodeType}`, JSON.stringify({
        timestamp: metadata.timestamp || Date.now(),
        signature: metadata.signature || null,
        burnTxHash: metadata.burnTxHash || null,
        burnAmount: metadata.burnAmount || null,
        nodeType: nodeType,
        phase: metadata.phase || 1,  // Default to Phase 1
        walletAddress: metadata.walletAddress || null  // The address used for activation
      }));
      
      // Encrypt the activation code — AES-256-GCM + PBKDF2 600K (v3)
      const { vault: codeVault } = await this._encryptGCM(code, password);

      // Store encrypted code with metadata
      encryptedCodes[nodeType] = {
        ...codeVault,
        nodeType: nodeType
      };
      
      await AsyncStorage.setItem('qnet_activation_codes', JSON.stringify(encryptedCodes));
      
      return true;
    } catch (error) {
      // console.error('Error storing activation code:', error);
      throw error;
    }
  }
  
  // Load and decrypt activation code
  async loadActivationCode(nodeType, password) {
    try {
      const codesStr = await AsyncStorage.getItem('qnet_activation_codes');
      if (!codesStr) {
        return null;
      }
      
      const encryptedCodes = JSON.parse(codesStr);
      const codeData = encryptedCodes[nodeType];
      
      if (!codeData) {
        return null;
      }
      
      // Decrypt the activation code (v3/v2=GCM, v1=CBC legacy)
      let decryptedStr;
      if (codeData.version === 3 || codeData.version === 2) {
        decryptedStr = await this._decryptGCM(codeData, password);
      } else {
        decryptedStr = await this._decryptCBC(codeData, password);
      }
      if (!decryptedStr) {
        throw new Error('Invalid password');
      }
      
      return decryptedStr;
    } catch (error) {
      // console.error('Error loading activation code:', error);
      throw error;
    }
  }

  // Synchronize activation codes from blockchain (called on wallet restore)
  // PRODUCTION: Codes are retrieved from QNet blockchain registry, NOT generated locally
  async syncActivationCodes(walletAddress, seedPhrase, password) {
    try {
      // Check for existing stored codes first (local cache)
      const existingCodes = await this.getStoredActivationCodes(password);
      
      if (existingCodes && Object.keys(existingCodes).length > 0) {
        // Verify on-chain before trusting local cache
        // Prevents stale codes from surviving network restarts
        try {
          const onChainResult = await this.verifyActivationOnChain(walletAddress);
          if (!onChainResult.verified && !onChainResult.networkError) {
            console.log('[syncActivationCodes] Local codes exist but NOT verified on-chain — ignoring cache');
            // Don't return cached codes — fall through to re-check server/blockchain
          } else {
            return existingCodes;
          }
        } catch (e) {
          // Network error — trust local cache as fallback
          return existingCodes;
        }
      }
      
      // First check if we have stored activation metadata
      // This is the most reliable way to know if node was activated
      const metaKeys = ['light', 'super']; // v4.10: Removed 'full' — Full Node type was removed in v3.18
      for (const nodeType of metaKeys) {
        const metaData = await AsyncStorage.getItem(`qnet_activation_meta_${nodeType}`);
        if (metaData) {
          const meta = JSON.parse(metaData);
          console.log(`Found activation metadata for ${nodeType} node`);
          
          // Regenerate code LOCALLY from stored burn metadata
          if (meta.burnTxHash && meta.burnAmount && password) {
            try {
              const code = this.generateActivationCodeLocally(
                nodeType, walletAddress, meta.burnTxHash, meta.burnAmount
              );
              await this.storeActivationCode(code, nodeType, password, {
                burnTxHash: meta.burnTxHash,
                burnAmount: meta.burnAmount,
                walletAddress: meta.walletAddress,
                phase: meta.phase || 1
              });
              return { [nodeType]: code };
            } catch (e) {
              console.warn('Failed to regenerate code locally:', e.message);
            }
          }
        }
      }
      
      // Query QNet blockchain for activations by wallet
      // FIX: backend expects "wallet_address" param (not "wallet")
      // FIX: backend returns "nodes" array (not "activations")
      const apiUrl = this.getRandomBootstrapNode();
      try {
        // Wallet via header, not the URL (privacy).
        const response = await fetch(
          `${apiUrl}/api/v1/activations/by-wallet`,
          { method: 'GET', timeout: 10000, headers: { 'X-QNet-Wallet': walletAddress } }
        );
        
        if (response.ok) {
          const result = await response.json();
          // Backend returns { success, nodes: [...] } — each node has node_id, node_type, status
          const allNodes = result.nodes || result.activations || [];
          // CRITICAL: Filter out pending_activation and HASH-only entries
          // These are NOT real activated nodes — just code generation records
          const nodes = allNodes.filter(n => 
            n.status !== 'pending_activation' && 
            !(n.activation_code && typeof n.activation_code === 'string' && n.activation_code.startsWith('HASH:'))
          );
          if (result.success && nodes.length > 0) {
            const node = nodes[0]; // Use first node (1 wallet = 1 node rule)
            const nodeType = node.node_type;
            const nodeId = node.node_id;
            
            // Backend may return activation_code directly (registry query) or we need to re-request
            let code = node.activation_code;
            
            if (!code && nodeId) {
              // Node exists in blockchain but activation_code not in this response
              // Regenerate code LOCALLY from stored burn metadata
              console.log('[syncActivationCodes] Node found on blockchain, regenerating activation code locally...');
              try {
                const metaStr = await AsyncStorage.getItem(`qnet_activation_meta_${nodeType}`);
                const meta = metaStr ? JSON.parse(metaStr) : null;
                if (meta && meta.burnTxHash && meta.burnAmount) {
                  code = this.generateActivationCodeLocally(
                    nodeType, walletAddress, meta.burnTxHash, meta.burnAmount
                  );
                }
              } catch (recoverError) {
                console.warn('[syncActivationCodes] Code regeneration failed:', recoverError.message);
              }
            }
            
            if (code && nodeType && password) {
              await this.storeActivationCode(code, nodeType, password, { fromBlockchain: true });
              return { [nodeType]: code };
            }
            
            // Even without code, return node info so UI knows a node exists
            if (nodeType) {
              return { [nodeType]: { nodeId, nodeType, status: node.status, needsCodeRecovery: !code } };
            }
          }
        }
      } catch (e) {
        console.warn('Failed to query blockchain for activations:', e.message);
      }
      
      // Fallback: Check Solana for burn transactions
      const activatedNodes = await this.checkBlockchainForActivations(walletAddress);
      
      // checkBlockchainForActivations returns array of node type strings: ['light'] or ['light','full','super']
      // If burn found, try to recover code from server using stored burn TX metadata
      if (activatedNodes && activatedNodes.length > 0) {
        console.log('[syncActivationCodes] 🔥 Burn found on Solana, attempting code recovery...');
        
        // Determine the best node type (single = exact, multiple = old activation without MEMO)
        const burnNodeType = activatedNodes.length === 1 ? activatedNodes[0] : 'light';
        
        // Look for burn TX hash in stored activation metadata
        const metaStr = await AsyncStorage.getItem(`qnet_activation_meta_${burnNodeType}`);
        const meta = metaStr ? JSON.parse(metaStr) : null;
        const burnTxHash = meta?.signature || meta?.burnTxHash;
        
        if (burnTxHash && meta?.burnAmount) {
          try {
            // Regenerate code LOCALLY — no server needed
            const code = this.generateActivationCodeLocally(
              burnNodeType, walletAddress, burnTxHash, meta.burnAmount
            );
            console.log('[syncActivationCodes] ✅ Code regenerated locally from burn TX');
            await this.storeActivationCode(code, burnNodeType, password, {
              burnTxHash,
              burnAmount: meta.burnAmount,
              walletAddress: meta.walletAddress || walletAddress,
              phase: meta?.phase || 1
            });
            return { [burnNodeType]: code };
          } catch (recoverError) {
            console.warn('[syncActivationCodes] Local code regeneration failed:', recoverError.message);
          }
        } else {
          console.log('[syncActivationCodes] ⚠️ Burn found but no TX hash in metadata for recovery');
        }
        
        // Burn exists but code cannot be recovered (no stored burn TX hash)
        return null;
      }
      
      // No activations found
      return null;
    } catch (error) {
      console.warn('[syncActivationCodes] Error:', error.message || error);
      return null;
    }
  }
  
  // DEPRECATED: Old sync logic kept for reference
  async _legacySyncActivationCodes(walletAddress, seedPhrase, password) {
    try {
      // Check cache for recent blockchain check
      const cacheKey = `blockchain_check_${walletAddress}`;
      const cachedResult = await AsyncStorage.getItem(cacheKey);
      if (cachedResult) {
        const cached = JSON.parse(cachedResult);
        const cacheAge = Date.now() - cached.timestamp;
        // Use cache if less than 30 seconds old
        if (cacheAge < 30 * 1000) {
          console.log('Using cached blockchain check result');
          if (cached.activatedNodes && cached.activatedNodes.length > 0) {
            // Process cached result - but codes should come from server!
            console.warn('[DEPRECATED] Using legacy code generation - should use server');
            const codes = {};
            if (seedPhrase) {
              codes.light = this.generateActivationCode('light', walletAddress, seedPhrase);
              codes.full = this.generateActivationCode('full', walletAddress, seedPhrase);  
              codes.super = this.generateActivationCode('super', walletAddress, seedPhrase);
            }
            const nodeType = cached.activatedNodes[0];
            const code = codes[nodeType];
            if (code && password) {
              await this.storeActivationCode(code, nodeType, password, { fromCache: true });
              return { [nodeType]: code };
            }
          }
          return null;
        }
      }
      
      // Generate deterministic codes from seed (DEPRECATED - for backward compatibility only)
      const codes = {};
      if (seedPhrase) {
        codes.light = this.generateActivationCode('light', walletAddress, seedPhrase);
        codes.full = this.generateActivationCode('full', walletAddress, seedPhrase);  
        codes.super = this.generateActivationCode('super', walletAddress, seedPhrase);
      }
      
      // Check blockchain for burn transactions
      const activatedNodes = await this.checkBlockchainForActivations(walletAddress);
      
      // Store code for activated node
      if (activatedNodes && activatedNodes.length > 0) {
        // First check if we already have a stored code
        const existingCodes = await this.getStoredActivationCodes(password);
        if (existingCodes && Object.keys(existingCodes).length > 0) {
          // Already have a code stored, keep it
          return existingCodes;
        }
        
        // Check if we have exact node type from MEMO
        if (activatedNodes.length === 1) {
          // Exact type determined from MEMO!
          const nodeType = activatedNodes[0];
          const code = codes[nodeType];
          
          if (code && password) {
            // console.log('[syncActivationCodes] Storing code for node type (from MEMO):', nodeType);
            await this.storeActivationCode(code, nodeType, password, { fromBlockchain: true });
            return { [nodeType]: code };
          }
        } else {
          // Old activation without MEMO - can't determine exact type
          // console.log('[syncActivationCodes] ⚠️ Old activation detected without MEMO');
          // console.log('[syncActivationCodes] Cannot determine exact node type');
          // console.log('[syncActivationCodes] Please re-activate your node with latest version');
          
          // Don't store anything - user needs to re-activate
          return null;
        }
      }
      
      // Return stored codes if any were found
      const storedCodes = await this.getStoredActivationCodes(password);
      if (storedCodes && Object.keys(storedCodes).length > 0) {
        return storedCodes;
      }
      
      return null; // No activated nodes found
    } catch (error) {
      // console.error('[syncActivationCodes] Error:', error);
      return null;
    }
  }
  
  /**
   * v4.10: Find burn transaction directly on Solana blockchain
   * Returns { burnTxHash, nodeType, burnAmount } or null
   * Used when local metadata was cleared (pm clear / reinstall)
   */
  async findBurnTransactionOnSolana(walletAddress) {
    try {
      const testnetSetting = await AsyncStorage.getItem('qnet_testnet');
      const isTestnet = testnetSetting === null ? true : testnetSetting === 'true';
      const rpcUrl = getSolanaRpcUrl(isTestnet);
      
      // Step 1: Get signatures — fetch enough to find the FIRST (oldest) burn TX
      const sigResponse = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [walletAddress, { limit: 50 }]
        })
      });
      
      if (!sigResponse.ok) return null;
      const sigData = await sigResponse.json();
      if (!sigData.result || sigData.result.length === 0) return null;
      
      // Step 2: Find ALL burn TXs with QNET_NODE_TYPE memo, then pick the OLDEST one.
      // Solana returns signatures newest-first, so we reverse to get oldest-first.
      // There should only ever be ONE valid burn TX per wallet (1 wallet = 1 node),
      // but if multiple exist for any reason, we always use the FIRST (original) burn.
      const burnSigs = sigData.result
        .filter(sig => sig.memo && sig.memo.includes('QNET_NODE_TYPE:') && !sig.err);
      if (burnSigs.length === 0) return null;
      // Oldest = last in the newest-first array
      const sig = burnSigs[burnSigs.length - 1];
      const match = sig.memo.match(/QNET_NODE_TYPE:(\w+)/);
      if (match) {
          const nodeType = match[1].toLowerCase();
          console.log(`[findBurnTx] Found burn TX (oldest): ${sig.signature.substring(0, 16)}... type=${nodeType} (${burnSigs.length} burn TX total)`);
            
          // Step 3: Get parsed transaction to extract burn amount
          await new Promise(r => setTimeout(r, 500)); // Rate limit protection
          try {
            const txResponse = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'getTransaction',
                params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
              })
            });
            
            if (txResponse.ok) {
              const txData = await txResponse.json();
              if (txData.result) {
                // Extract burn amount from instructions — MUST be integer (no floats for XOR key)
                let burnAmount = 0;
                const instructions = txData.result?.transaction?.message?.instructions || [];
                for (const inst of instructions) {
                  if (inst.parsed && inst.parsed.type === 'burn' && inst.parsed.info) {
                    const rawAmount = parseInt(inst.parsed.info.amount || '0');
                    const decimals = inst.parsed.info.decimals || 6;
                    // Math.round CRITICAL: avoids floating-point drift (e.g. 1499.9999 vs 1500)
                    burnAmount = Math.round(rawAmount / Math.pow(10, decimals));
                    break;
                  }
                }
                
                return {
                  burnTxHash: sig.signature,
                  nodeType: nodeType,
                  burnAmount: burnAmount > 0 ? burnAmount : null, // Must be real — no defaults
                  blockTime: sig.blockTime
                };
              }
            }
            } catch (txErr) {
              // Can't get amount — return TX hash but no amount (caller must handle)
              return {
                burnTxHash: sig.signature,
                nodeType: nodeType,
                burnAmount: null,
                blockTime: sig.blockTime
              };
            }
          }
      
      return null;
    } catch (error) {
      console.warn('[findBurnTx] Error:', error.message);
      return null;
    }
  }

  // Check blockchain for burn transactions to find activated nodes
  // v4.10: Added rate-limit protection — initial delay + retry with backoff
  async checkBlockchainForActivations(walletAddress) {
    try {
      console.warn('[QNET_DEBUG] checkBlockchainForActivations called for:', walletAddress);
      const activatedNodes = [];
      
      // Get network setting
      const testnetSetting = await AsyncStorage.getItem('qnet_testnet');
      const isTestnet = testnetSetting === null ? true : testnetSetting === 'true';
      
      // Burn contract for checking
      const BURN_CONTRACT_ID = 'CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw';
      
      try {
        // Import Solana web3
        const { Connection, PublicKey } = require('@solana/web3.js');
        
        // v4.10: Centralized RPC URL with timeout + fetch middleware for 429 retry
        const connection = new Connection(getSolanaRpcUrl(isTestnet), {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: 15000,
        });
        
        // v4.10: Initial delay to stagger with other parallel Solana RPC calls
        // (loadBalance, getBurnProgress run first — we wait to avoid 429)
        await new Promise(r => setTimeout(r, 2000));
        
        // Smart transaction fetching strategy
        // 1. First check recent transactions (fast)
        let signatures = await connection.getSignaturesForAddress(
          new PublicKey(walletAddress),
          { limit: 5 } // v4.10: Reduced from 10→5 to reduce RPC calls
        );
        
        // v4.10: Helper to avoid Solana 429 rate limits
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        
        // v4.10: FAST PATH — check memo field from signatures (no extra RPC calls needed)
        // Solana returns memo in getSignaturesForAddress response, e.g. "[20] QNET_NODE_TYPE:LIGHT"
        const detectedTypes = new Set();
        for (const sig of signatures) {
          if (sig.memo && sig.memo.includes('QNET_NODE_TYPE:') && !sig.err) {
            const memoText = sig.memo;
            const nodeTypeMatch = memoText.match(/QNET_NODE_TYPE:(\w+)/);
            if (nodeTypeMatch) {
              const detectedType = nodeTypeMatch[1].toLowerCase();
              console.log(`[checkBlockchainForActivations] Fast-path: found ${detectedType} burn via memo`);
              detectedTypes.add(detectedType);
            }
          }
        }
        if (detectedTypes.size > 0) {
          // Return exact detected types (light, super, or both if multiple burns)
          return Array.from(detectedTypes);
        }
        
        console.log('[checkBlockchainForActivations] No memo fast-path hit, checking transaction details...');
        
        // Function to check transactions in batches
        // v4.10: Reduced batch size from 5→2 and added 500ms delay between batches
        // to avoid Solana public RPC 429 rate limiting
        const checkTransactionBatch = async (sigs) => {
          const txPromises = [];
          const txSignatures = []; // Store signatures for later use
          const maxBatchSize = 2; // v4.10: Reduced from 5 to avoid 429
          
          for (let i = 0; i < sigs.length; i++) {
            const sigInfo = sigs[i];
            txPromises.push(
              connection.getParsedTransaction(sigInfo.signature)
                .then(tx => ({ tx, sigInfo })) // Include sigInfo with transaction
                .catch(err => {
                  console.log('Failed to get tx:', err.message);
                  return null;
                })
            );
            
            // Process in batches
            if (txPromises.length === maxBatchSize || i === sigs.length - 1) {
              const txBatch = await Promise.all(txPromises);
              // v4.10: Delay between batches to respect Solana RPC rate limits
              if (i < sigs.length - 1) await sleep(500);
              
              for (const result of txBatch) {
                if (!result) continue;
                const { tx, sigInfo } = result;
                
                if (tx && tx.meta && !tx.meta.err) {
              // Check if this transaction involves burn contract
              const instructions = tx.transaction.message.instructions;
              
              for (const inst of instructions) {
                // Check for burn program or token burn
                if (inst.programId && inst.programId.toString() === BURN_CONTRACT_ID) {
                  // Found burn transaction but can't determine type in Phase 1
                  // All nodes have DYNAMIC pricing (1500-300 1DEV based on burn %)
                  // Return all types and let sync logic determine which one
                  return ['light', 'super']; // v4.10: Removed 'full'
                }
                
                // Also check for SPL token burns
                if (inst.program === 'spl-token' && inst.parsed && inst.parsed.type === 'burn') {
                  // Check if it's 1DEV token
                  const oneDevMint = isTestnet 
                    ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'
                    : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';
                  
                  if (inst.parsed.info && inst.parsed.info.mint === oneDevMint) {
                    // Found 1DEV burn - now check for MEMO to determine type
                    // console.log('[checkBlockchainForActivations] Found 1DEV burn, checking for memo...');
                    
                    // Look for MEMO instruction in the same transaction
                    let nodeType = null;
                    for (const memoInst of instructions) {
                      if (memoInst.program === 'spl-memo' || 
                          (memoInst.programId && memoInst.programId.toString() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')) {
                        // Found memo instruction - parse the data
                        let memoData = null;
                        if (memoInst.parsed) {
                          memoData = memoInst.parsed;
                        } else if (memoInst.data) {
                          // Decode base58 data
                          try {
                            const bs58 = require('bs58');
                            memoData = Buffer.from(bs58.decode(memoInst.data)).toString('utf-8');
                          } catch (e) {
                            // Try as base64 if bs58 fails
                            try {
                              memoData = Buffer.from(memoInst.data, 'base64').toString('utf-8');
                            } catch (e2) {
                              // Failed to decode
                            }
                          }
                        }
                        
                        if (memoData && typeof memoData === 'string') {
                          // Check if it's our node type memo
                          const match = memoData.match(/QNET_NODE_TYPE:(\w+)/);
                          if (match && match[1]) {
                            nodeType = match[1].toLowerCase();
                            // console.log('[checkBlockchainForActivations] Found node type in memo:', nodeType);
                            break;
                          }
                        }
                      }
                    }
                    
                    if (nodeType && ['light', 'super'].includes(nodeType)) {
                      // Found exact type from memo!
                      // console.log('[checkBlockchainForActivations] ✅ Exact node type determined:', nodeType);
                      // Store activation metadata for future quick lookups and code recovery
                      await AsyncStorage.setItem(`qnet_activation_meta_${nodeType}`, JSON.stringify({
                        timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
                        signature: sigInfo.signature,
                        burnTxHash: sigInfo.signature, // CRITICAL: burn TX hash = Solana signature
                        nodeType: nodeType,
                        phase: 1
                      }));
                      return [nodeType];
                    } else {
                      // Old activation without memo - store metadata and return all types
                      await AsyncStorage.setItem('qnet_activation_meta_light', JSON.stringify({
                        timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
                        signature: sigInfo.signature,
                        burnTxHash: sigInfo.signature,
                        nodeType: 'light',
                        phase: 1
                      }));
                      return ['light', 'super']; // v4.10: Removed 'full'
                    }
                  }
                }
              }
              
                // Early exit if we found activation
                if (activatedNodes.length > 0) {
                  break;
                }
                }
              }
              
              // Clear promise array for next batch
              txPromises.length = 0;
            
              // Early exit if we found activation
              if (activatedNodes.length > 0) {
                return activatedNodes;
              }
            }
          }
          return activatedNodes;
        };
        
        // First, quick check of recent transactions
        let result = await checkTransactionBatch(signatures);
        if (result && result.length > 0) {
          activatedNodes.push(...result);
        }
        
        // If not found in recent, do targeted search for burn transactions
        if (activatedNodes.length === 0) {
          console.log('Not found in recent transactions, searching for burn transactions...');
          
          // Search specifically for 1DEV token burns (more targeted)
          const oneDevMint = isTestnet 
            ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'
            : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';
          
          // Get more transactions but only check those that involve token program
          signatures = await connection.getSignaturesForAddress(
            new PublicKey(walletAddress),
            { 
              limit: 50, // Check more transactions
              before: signatures.length > 0 ? signatures[signatures.length - 1].signature : undefined
            }
          );
          
          // Filter signatures to only check potential burn transactions
          // This is a heuristic - transactions with errors are skipped
          const filteredSigs = signatures.filter(sig => !sig.err);
          
          // Check next batch (but limit processing)
          if (filteredSigs.length > 0) {
            result = await checkTransactionBatch(filteredSigs.slice(0, 20));
            if (result && result.length > 0) {
              activatedNodes.push(...result);
            }
          }
        }
      } catch (rpcError) {
        // console.log('[checkBlockchainForActivations] RPC check error:', rpcError);
        // Continue without blockchain check
      }
      
      // Cache the result
      const cacheKey = `blockchain_check_${walletAddress}`;
      await AsyncStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        activatedNodes: activatedNodes
      }));
      
      return activatedNodes;
    } catch (error) {
      // console.error('[checkBlockchainForActivations] Error:', error);
      return [];
    }
  }
  
  // Get all stored activation codes
  async getStoredActivationCodes(password) {
    try {
      // Password is required for decryption
      if (!password) {
        return {};
      }
      
      const codesStr = await AsyncStorage.getItem('qnet_activation_codes');
      if (!codesStr) return {};
      
      let encryptedCodes = {};
      try {
        encryptedCodes = JSON.parse(codesStr);
      } catch (parseError) {
        // Invalid format - clear and return empty
        await AsyncStorage.removeItem('qnet_activation_codes');
        return {};
      }
      
      const decryptedCodes = {};
      
      for (const [nodeType, codeData] of Object.entries(encryptedCodes)) {
        try {
          // Validate codeData structure
          if (!codeData || typeof codeData !== 'object') {
            continue;
          }
          
          if (codeData.salt && codeData.iv && codeData.encrypted) {
            try {
              let code;
              if (codeData.version === 3 || codeData.version === 2) {
                code = await this._decryptGCM(codeData, password);
              } else {
                code = await this._decryptCBC(codeData, password);
              }
              if (code && code.length > 0) {
                decryptedCodes[nodeType] = {
                  code,
                  timestamp: codeData.timestamp || Date.now()
                };
              }
            } catch (decryptError) {
              // Decryption failed - skip this code
            }
          }
        } catch (err) {
          // Error processing this code - skip
        }
      }
      
      return decryptedCodes;
    } catch (error) {
      // console.error('Error getting stored activation codes:', error);
      return {};
    }
  }
  
  // Calculate dynamic activation cost based on burn percentage
  // Calculate activation cost (Light and Super nodes only)
  // Dynamic pricing: 1500 base at 0% burned → 300 minimum at 80%+ burned
  async calculateActivationCost(nodeType = 'super') {
    // Phase 1 Economic Model — declared outside try for catch access
    const PHASE_1_BASE_PRICE = 1500; // Base cost in 1DEV at 0% burned
    const PRICE_REDUCTION_PER_10_PERCENT = 150; // 150 1DEV reduction per 10% burned
    try {
      const burnPercent = parseFloat((await this.getBurnProgress(false)) ?? '0'); // null ⇒ treat as 0% (same as old fallback)
      const MINIMUM_PRICE = 300; // Minimum price at 80-90% burned
      
      // Check if Phase 2 (90% burned or 5 years passed)
      if (burnPercent >= 90) {
        // Phase 2: QNC activation with dynamic network multiplier
        // v3.18: Only Light and Super nodes (Full removed)
        const phase2BaseCosts = {
          light: 10000,  // Light: 10,000 QNC base
          super: 7500    // Super: 7,500 QNC base
        };
        
        // Get real active nodes count from blockchain
        const activeNodesCount = await this.getActiveNodesCount(false); // Use mainnet for pricing
        
        // Calculate network size multiplier
        let multiplier = 1.0;
        if (activeNodesCount <= 100000) {
          multiplier = 0.5; // Early network discount
        } else if (activeNodesCount <= 300000) {
          multiplier = 1.0; // Standard rate
        } else if (activeNodesCount <= 1000000) {
          multiplier = 2.0; // High demand
        } else {
          multiplier = 3.0; // Mature network (1M+)
        }
        
        // Default to super if invalid type
        const baseCost = phase2BaseCosts[nodeType] || phase2BaseCosts.super;
        const finalCost = Math.round(baseCost * multiplier);
        
        return {
          cost: finalCost,
          baseCost: baseCost,
          currency: 'QNC',
          phase: 2,
          mechanism: 'transfer', // Transfer to Pool 3, not burn
          description: `Transfer ${finalCost} QNC to Pool #3 (${activeNodesCount.toLocaleString()} active nodes, ${multiplier}x rate)`,
          networkSize: activeNodesCount,
          multiplier: multiplier
        };
      }
      
      // Phase 1: Dynamic 1DEV pricing
      // Calculate current price: Every 10% burned = -150 1DEV reduction
      const reductionTiers = Math.floor(burnPercent / 10);
      const totalReduction = reductionTiers * PRICE_REDUCTION_PER_10_PERCENT;
      const currentPrice = Math.max(PHASE_1_BASE_PRICE - totalReduction, MINIMUM_PRICE);
      
      return {
        cost: currentPrice,
        currency: '1DEV',
        phase: 1,
        mechanism: 'burn',
        burnPercent: burnPercent,
        savings: PHASE_1_BASE_PRICE - currentPrice,
        baseCost: PHASE_1_BASE_PRICE,
        description: `Burn ${currentPrice} 1DEV for activation (${burnPercent.toFixed(1)}% already burned)`
      };
    } catch (error) {
      console.warn('[PRICING] Error calculating activation cost:', error.message);
      // Fallback: fetch dynamic price from server pricing endpoint
      try {
        const apiUrl = this.getRandomBootstrapNode();
        const pricingResponse = await fetch(`${apiUrl}/api/v1/activation/price?type=${nodeType}`);
        const serverPricing = await pricingResponse.json();
        if (serverPricing.cost > 0) {
          return {
            cost: serverPricing.cost,
            currency: serverPricing.currency || '1DEV',
            phase: serverPricing.phase || 1,
            mechanism: serverPricing.mechanism || 'burn',
            burnPercent: serverPricing.burn_percentage || 0,
            baseCost: serverPricing.base_cost || serverPricing.cost,
            description: `Burn ${serverPricing.cost} ${serverPricing.currency || '1DEV'} for activation`,
            isEstimate: false
          };
        }
      } catch (fallbackErr) {
        console.warn('[PRICING] Server pricing fallback failed:', fallbackErr.message);
      }
      // Last resort: use base price (max cost) — user never underpays
      return {
        cost: PHASE_1_BASE_PRICE,
        currency: '1DEV',
        phase: 1,
        mechanism: 'burn',
        burnPercent: 0,
        baseCost: PHASE_1_BASE_PRICE,
        description: 'Burn 1DEV for activation (price may be lower — check network status)',
        isEstimate: true
      };
    }
  }
  
  // Activate Light Node - REQUIRES REAL 1DEV BURN
  async activateLightNode(walletAddress, password) {
    try {
      // Quick local check only (blockchain check is too slow - 30+ RPC calls)
      const existingCodes = await this.getStoredActivationCodes(password);
      if (existingCodes && Object.keys(existingCodes).length > 0) {
        throw new Error('This wallet already has an activated node. One wallet can only activate one node.');
      }
      
      // Load wallet and get seed phrase separately for security
      const walletData = await this.loadWallet(password);
      if (!walletData) {
        throw new Error('Failed to load wallet data');
      }
      
      // Get mnemonic securely from encrypted storage
      const mnemonic = await this.getEncryptedMnemonic(password);
      if (!mnemonic) {
        throw new Error('Failed to retrieve seed phrase');
      }
      
      // Check testnet/mainnet - default to true (testnet) if not set
      const testnetSetting = await AsyncStorage.getItem('qnet_testnet');
      const isTestnet = testnetSetting === null ? true : testnetSetting === 'true';
      
      // Get dynamic pricing for light node
      const pricing = await this.calculateActivationCost('light');
      if (!pricing) {
        throw new Error('Failed to calculate activation cost');
      }
      
      // BURN REAL TOKENS for activation
      const burnResult = await this.burnTokensForNode('light', pricing.cost, isTestnet, password);
      
      if (!burnResult || !burnResult.signature) {
        throw new Error('Failed to burn tokens for activation');
      }
      
    // Generate activation code LOCALLY — deterministic XOR, no server dependency.
    // Inputs are all from Solana blockchain → always reproducible for recovery.
    // Validation (burn TX exists, amount OK, 1-wallet-1-node) happens at registration.
    const activationCode = this.generateActivationCodeLocally(
      'light',
      walletAddress,        // Solana address (burn wallet, used for XOR)
      burnResult.signature, // burn TX hash
      pricing.cost          // exact burned amount
    );
    
    // Store the activation code with ALL metadata (burnAmount included for stateless XOR)
    // storeActivationCode now saves burnAmount in qnet_activation_meta_light — no duplicate write needed
    await this.storeActivationCode(activationCode, 'light', password, {
      burnTxHash: burnResult.signature,
      burnAmount: pricing.cost,
      phase: 1,
      walletAddress: walletAddress
    });
    
    // CRITICAL: Save qnet_last_activated_node immediately after burn
    // Without this, data is lost if user closes the app before clicking "Activate Node"
    const burnPseudonym = this.generateLightNodePseudonym(walletAddress);
    await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
      nodeType: 'light',
      code: activationCode,
      pseudonym: burnPseudonym,
      timestamp: Date.now(),
      burnTxHash: burnResult.signature,
      walletAddress: walletAddress
    }));
    await AsyncStorage.setItem(`node_pseudonym_${activationCode}`, burnPseudonym);

    return {
      success: true,
      signature: burnResult.signature,
      activationCode,
      nodeType: 'light',
      burned: pricing.cost,
      timestamp: Date.now()
    };
    } catch (error) {
      // console.error('Error activating light node:', error);
      throw error;
    }
  }
  
  // Query any node to verify that walletAddress has an active registration on-chain.
  // Returns { verified: true, node_id, node_type } or { verified: false }.
  async checkOnChainActivation(walletAddress) {
    try {
      const apiUrl = this.getRandomBootstrapNode();
      // Wallet via header, not the URL (privacy).
      const url = `${apiUrl}/api/v1/verify-activation`;
      const resp = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json', 'X-QNet-Wallet': walletAddress } });
      if (!resp.ok) return { verified: false };
      const data = await resp.json();
      return data;
    } catch (_) {
      return { verified: false };
    }
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
  
  // v6.0: Create a NodeRegistration TX client-side and submit it to the current producer.
  // Called after /api/v1/light-node/register returns registration_proof.
  // Signing message: "client_node_reg:{node_id}:{wallet_address}:{registration_proof}:{timestamp}"
  async createAndSubmitNodeRegistrationTx(nodeId, walletAddress, registrationProof, password, dilithiumKeys, burnTxHash, burnAmount, burnWallet) {
    const walletData = await this.loadWallet(password);
    if (!walletData || !walletData.secretKey) {
      throw new Error('Cannot sign NodeRegistration TX: wallet not loaded');
    }

    // PURE DILITHIUM (F0.1): wallet control is proven by the ML-DSA-65 WALLET key (which derives to
    // wallet_address — the node checks eon_from_qnet_dilithium_pubkey(dilithium_public_key)==wallet_address).
    // Ed25519 is a Solana-only credential and is NOT sent for a QNet registration.
    const qk = walletData.qnetKeypair;
    if (!qk || !qk.privateKey || !qk.publicKey) {
      throw new Error('No ML-DSA-65 QNet key in wallet — required for pure-Dilithium registration');
    }
    const walletDilPkHex = Buffer.from(new Uint8Array(qk.publicKey)).toString('hex');
    const walletDilSkHex = Buffer.from(new Uint8Array(qk.privateKey)).toString('hex');

    const timestamp = Math.floor(Date.now() / 1000);
    const message = `client_node_reg:${nodeId}:${walletAddress}:${registrationProof}:${timestamp}`;

    const payload = {
      from: walletAddress,
      node_id: nodeId,
      node_type: 'light',
      wallet_address: walletAddress,
      registration_proof: registrationProof,
      timestamp,
    };

    // Option A: carry the Solana 1DEV burn so the server can build a burn-attested ON-CHAIN Light
    // registration (without it the TX has an empty burn and is hard-rejected at the gate). The burn is
    // already cryptographically committed by registration_proof = blake3(burn:node_id:wallet)[..32],
    // so the server binds it by recomputing the proof — no extra signed field is needed.
    if (burnTxHash) payload.burn_tx_hash = burnTxHash;
    if (burnAmount) payload.burn_amount = burnAmount;
    if (burnWallet) payload.burn_wallet = burnWallet;

    // MANDATORY: the WALLET Dilithium public key is this node's IMMUTABLE on-chain attestation root and
    // ALSO its wallet-control proof — the node checks eon_from_qnet_dilithium_pubkey(dilithium_public_key)
    // == wallet_address and verifies every liveness attestation against it. Fail hard if the key is absent.
    {
      // Sign client_node_reg with the WALLET Dilithium key; signer_id = the raw pubkey hex so the node
      // verifies via the same "dilithium_sig_{pk}_{b64}" wire format. Proves control of the wallet whose
      // address == wallet_address, and pins that key as the node's attestation root.
      const { signWithDilithium } = require('../crypto/DilithiumCrypto');
      const dilSig = await signWithDilithium(message, walletDilSkHex, walletDilPkHex, walletDilPkHex);
      if (!dilSig) throw new Error('Dilithium registration signature failed');
      payload.dilithium_signature = dilSig;
      payload.dilithium_public_key = walletDilPkHex;
    }

    // Proof-of-ownership of the burning Solana wallet: sign with the Solana key, node verifies against
    // burn_wallet. Binds THIS on-chain registration (which commits the immutable attestation root) to the
    // wallet owner — stops an attacker front-running our first registration with our public burn_tx.
    {
      const solSecret = walletData.secretKey instanceof Uint8Array
        ? walletData.secretKey : new Uint8Array(walletData.secretKey);
      const ownerMsg = `qnet_onchain_reg:${nodeId}:${walletAddress}:${registrationProof}:${timestamp}`;
      const ownerSig = nacl.sign.detached(Buffer.from(ownerMsg, 'utf8'), solSecret);
      payload.owner_signature = Buffer.from(ownerSig).toString('hex');
    }

    // Hedged submit — timeout-bounded across two nodes; gossip routes it to the producer.
    let result;
    try {
      const res = await this._hedged('/api/v1/node-registration/submit', { method: 'POST', body: payload, timeoutMs: 8000, hedgeMs: 1200 });
      result = res.data || {};
    } catch (netErr) {
      throw new Error('Failed to submit NodeRegistration TX: all nodes unreachable');
    }
    if (result.success) console.log('[NodeReg] submitted hash:', result.tx_hash);
    else console.warn('[NodeReg] rejected:', result.error);
    return result;
  }

  // Register node with activation code
  // PRODUCTION: Uses real Dilithium3 (ML-DSA-65) signatures + PushService for correct API
  // FALLBACK: If Dilithium not available, stores locally and registers without quantum sig
  async registerNodeWithCode(activationCode, walletAddress, password) {
    // Hoisted so catch block can reference them for storeActivationCode + on-chain recovery
    let burnTxHash = null;
    let burnAmount = null;
    let burnWallet = null;

    try {
      const nodeType = 'light';
      const systemPseudonym = this.generateLightNodePseudonym(walletAddress);

      // Try Dilithium3 registration first (full quantum-secure)
      let registrationResult = null;
      let quantumSecured = false;

      try {
        const { signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
        const { registerLightNode } = require('../services/PushService');

        if (isDilithiumAvailable()) {
          // Generate or load Dilithium3 keypair
          const dilithiumKeys = await this._walletDilithiumKeys(password);

          // Part 1 (Dilithium3): Sign wallet_address — quantum-resistant identity proof
          // Server verifies: verify_mobile_dilithium_signature(wallet_address, sig, pubkey)
          const registrationMessage = walletAddress;
          const quantumSignature = await signWithDilithium(
            registrationMessage,
            dilithiumKeys.secretKey,
            dilithiumKeys.publicKey,
            systemPseudonym
          );

          // Pure ML-DSA-65: the Dilithium3 Part-1 signature above is the sole gossip authenticator.
          // The former Part-2 Ed25519 (light_node_gossip:...) proof is removed.

          // ── PING DELEGATION v7.1: Dilithium3 (full quantum safety) ──────
          // Dedicated Dilithium3 ping keypair stored in Keychain (hardware-encrypted).
          // The wallet Dilithium key signs a delegation cert authorizing the ping key.
          // Background FCM handler signs with ping key — wallet key stays encrypted.
          let pingPubkeyHex = null;
          let pingDelegationCert = null;
          try {
            const Keychain = require('react-native-keychain');
            const { generateRawDilithiumKeypair } = require('../crypto/DilithiumCrypto');

            const existingPingSk = await Keychain.getGenericPassword({
              service: `qnet_ping_sk_${systemPseudonym}`,
            });
            const existingPingPk = await AsyncStorage.getItem(`qnet_ping_dilithium_pk_${systemPseudonym}`);

            if (existingPingSk && existingPingSk.password
                && existingPingPk && existingPingPk.length === 3904) {
              pingPubkeyHex = existingPingPk;
              console.log('[Registration] Reusing existing Dilithium3 ping keypair');
            } else {
              const randomBytes = crypto.getRandomValues(new Uint8Array(32));
              const pingSeed = `QNET_PING_${Buffer.from(randomBytes).toString('hex')}`;
              const pingKp = await generateRawDilithiumKeypair(pingSeed);
              pingPubkeyHex = pingKp.publicKey;

              await Keychain.setGenericPassword(
                `ping_key_${systemPseudonym}`,
                pingKp.secretKey,
                {
                  service: `qnet_ping_sk_${systemPseudonym}`,
                  accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
                }
              );
              await AsyncStorage.setItem(`qnet_ping_dilithium_pk_${systemPseudonym}`, pingPubkeyHex);
              console.log('[Registration] Dilithium3 ping keypair generated and stored');
            }

            const delegationMsg = `delegate_ping:${pingPubkeyHex}:${systemPseudonym}`;
            pingDelegationCert = await signWithDilithium(
              delegationMsg,
              dilithiumKeys.secretKey,
              dilithiumKeys.publicKey,
              systemPseudonym,
            );
            // Persist the cert so ping-response / self-attest can present it to a genesis for on-chain-key
            // verification (anti-poison: the node's own authenticated ping key overwrites any gossip poison).
            await AsyncStorage.setItem(`qnet_ping_cert_${systemPseudonym}`, pingDelegationCert);
            await AsyncStorage.setItem('qnet_ping_node_id', systemPseudonym);
            console.log('[Registration] Ping delegation cert created (quantum-safe)');
          } catch (pingErr) {
            console.warn('[Registration] Ping delegation setup failed (non-fatal):', pingErr.message);
            pingPubkeyHex = null;
            pingDelegationCert = null;
          }
          // ── END PING DELEGATION ─────────────────────────────────────────

          // v4.3: Get burn TX data for STATELESS code ownership verification
          // Node needs burn_tx_hash + burn_amount to reconstruct XOR key and verify
          // that the activation code truly belongs to this wallet — no server state needed
          // Note: burnTxHash / burnAmount / burnWallet are hoisted to method scope for catch access
          try {
            const metaStr = await AsyncStorage.getItem('qnet_activation_meta_light');
            if (metaStr) {
              const meta = JSON.parse(metaStr);
              burnTxHash = meta.burnTxHash || null;
              burnAmount = meta.burnAmount || null;
              burnWallet = meta.walletAddress || null; // Solana address used during code gen
            }
            if (!burnTxHash) {
              const lastNode = await AsyncStorage.getItem('qnet_last_activated_node');
              if (lastNode) {
                const ln = JSON.parse(lastNode);
                burnTxHash = ln.burnTxHash || null;
              }
            }
            // Fallback: try to get Solana address from wallet address storage
            if (!burnWallet) {
              // qnet_wallet_address stores the Solana publicKey directly (unencrypted)
              const storedAddr = await AsyncStorage.getItem('qnet_wallet_address');
              if (storedAddr) {
                burnWallet = storedAddr;
              }
            }
          } catch (_) { /* best effort */ }
          
          // v4.8: If burnAmount or burnTxHash is missing from local storage,
          // fall back to finding the burn transaction directly on Solana blockchain.
          // This handles: fresh install, seed restore, or metadata saved without burnAmount.
          if ((!burnTxHash || !burnAmount) && burnWallet) {
            try {
              console.log('[Registration] Burn metadata incomplete, searching Solana for burn TX...');
              const burnInfo = await this.findBurnTransactionOnSolana(burnWallet);
              if (burnInfo) {
                burnTxHash = burnTxHash || burnInfo.burnTxHash;
                burnAmount = burnAmount || burnInfo.burnAmount;
                console.log('[Registration] Found burn TX on Solana:', burnTxHash, 'amount:', burnAmount);
                // Update local metadata with found data
                await AsyncStorage.setItem('qnet_activation_meta_light', JSON.stringify({
                  burnTxHash,
                  burnAmount,
                  walletAddress: burnWallet,
                  nodeType: 'light',
                  phase: 1,
                  timestamp: Date.now()
                }));
              }
            } catch (solanaErr) {
              console.warn('[Registration] Solana burn TX lookup failed:', solanaErr.message);
            }
          }

          // v4.7: Sign with Solana Ed25519 key to prove wallet ownership
          // Prevents stolen code reuse — attacker cannot sign without private key
          // FIX: qnet_wallet stores ENCRYPTED vault — must use loadWallet(password) to decrypt
          let ed25519Signature = null;
          let signatureTimestamp = null;
          try {
            const wd = await this.loadWallet(password);
            if (wd && wd.secretKey) {
              signatureTimestamp = Math.floor(Date.now() / 1000);
              const message = `qnet_register:${activationCode}:${signatureTimestamp}`;
              const messageBytes = Buffer.from(message, 'utf8');
              const secretKeyBytes = new Uint8Array(wd.secretKey);
              const sig = nacl.sign.detached(messageBytes, secretKeyBytes);
              ed25519Signature = Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');
              console.log('[Registration] Ed25519 wallet ownership signature created');
            }
          } catch (sigErr) {
            console.warn('[Registration] Ed25519 signature failed:', sigErr.message);
            throw new Error(`Wallet ownership proof (Ed25519 signature) required: ${sigErr.message}`);
          }
          
          if (!ed25519Signature) {
            throw new Error('Ed25519 wallet ownership signature is required. Ensure wallet has Solana private key.');
          }

          // Step 1: Verify burn + register node locally on server
          // Server returns node_id + registration_proof (no longer creates on-chain TX)
          registrationResult = await registerLightNode(
            activationCode,
            walletAddress,
            dilithiumKeys.publicKey,
            quantumSignature,
            burnTxHash,
            burnAmount,
            burnWallet,
            ed25519Signature,
            signatureTimestamp,
            pingPubkeyHex,            // PING DELEGATION v7.0: ping hot key pubkey
            pingDelegationCert,       // PING DELEGATION v7.0: Dilithium cert
          );
          quantumSecured = true;

          // Step 2: Create and submit NodeRegistration TX client-side (v6.0)
          // TX is signed by wallet key and routed directly to the current producer.
          // This replaces the old server-side TX creation and eliminates up-to-30-sec latency.
          if (registrationResult && registrationResult.success && registrationResult.tx_required) {
            try {
              const txResult = await this.createAndSubmitNodeRegistrationTx(
                registrationResult.node_id,
                walletAddress,
                registrationResult.registration_proof,
                password,
                dilithiumKeys,
                burnTxHash,   // Option A: server embeds the burn + committee attestation into the on-chain TX
                burnAmount,
                burnWallet
              );
              console.log('[Registration] NodeRegistration TX submitted:', txResult.tx_hash);
              if (txResult.tx_hash) {
                registrationResult.onchain_tx_hash = txResult.tx_hash;
              }
            } catch (txErr) {
              // TX submission failure is non-fatal: the node is already registered locally
              // on the server (ping/heartbeat works), TX will be retried or re-submitted later
              console.warn('[Registration] NodeRegistration TX submission failed (non-fatal):', txErr.message);
              registrationResult.tx_pending = true;
            }
          }
        }
      } catch (dilithiumError) {
        // Re-throw server/network errors as-is so WalletScreen shows proper error messages.
        // Only wrap actual Dilithium/Ed25519 crypto errors.
        const msg = dilithiumError.message || '';
        console.error('[Registration] Error in quantum registration block:', msg);
        const isCryptoError = msg.includes('DilithiumModule') ||
          msg.includes('Dilithium3') ||
          msg.includes('dilithium') ||
          msg.includes('Ed25519 wallet ownership') ||
          msg.includes('Wallet ownership proof') ||
          msg.includes('generateKeypair') ||
          msg.includes('Failed to sign');
        if (isCryptoError) {
          console.warn('[Registration] Dilithium3 signature failed:', msg);
          throw new Error(`Quantum signature failed: ${msg}`);
        }
        // Server / network error — pass through directly
        console.warn('[Registration] Registration rejected by server:', msg);
        throw dilithiumError;
      }

      // No fallback — Dilithium3 is mandatory for node registration
      if (!registrationResult) {
        throw new Error('Dilithium3 module not available. Quantum signature is required for node registration.');
      }

      // ALWAYS store activation code locally, even if network registration fails
      // This prevents data loss — code was already paid for via 1DEV burn
      // CRITICAL: pass burnTxHash + burnAmount so metadata is NOT overwritten with null
      await this.storeActivationCode(activationCode, nodeType, password, {
        burnTxHash: burnTxHash || null,
        burnAmount: burnAmount || null,
        walletAddress: burnWallet || null,
        phase: 1
      });
      await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());
      await AsyncStorage.setItem(`node_pseudonym_${activationCode}`, systemPseudonym);

      // Store next ping time from backend (if available)
      if (registrationResult && registrationResult.next_ping_time) {
        await AsyncStorage.setItem(`node_next_ping_${activationCode}`, registrationResult.next_ping_time.toString());
      }

      const alreadyRegistered = !!(registrationResult && registrationResult.already_registered);

      return {
        success: true,
        alreadyRegistered,
        nodeType,
        pseudonym: (registrationResult && registrationResult.node_id) || systemPseudonym,
        burnTxHash: burnTxHash || null,
        message: alreadyRegistered
          ? (registrationResult.message || 'Node already registered. Your existing node has been restored.')
          : registrationResult
            ? 'Node successfully activated and registered in blockchain'
            : 'Node activation saved locally. Network registration will retry automatically.',
        nextPingTime: registrationResult ? registrationResult.next_ping_time : null,
        nextPingWindow: registrationResult ? registrationResult.next_ping_window : null,
        quantumSecured,
        pendingRegistration: !registrationResult
      };

    } catch (error) {
      console.warn('[Registration] Node activation failed:', error.message);

      // Store activation code locally even on failure (paid via 1DEV burn)
      // CRITICAL: preserve burnTxHash + burnAmount so future retries can send them to server
      try {
        await this.storeActivationCode(activationCode, 'light', password, {
          burnTxHash: burnTxHash || null,
          burnAmount: burnAmount || null,
          walletAddress: burnWallet || null,
          phase: 1
        });
      } catch (storeError) {
        // Silent — at least we tried to save the code
      }

      // Race condition guard: even if the client got an error (network timeout,
      // Solana indexing lag, partial response), the server might have already
      // written the NodeRegistration TX to the chain. Verify before surfacing failure.
      try {
        const onChain = await this.checkOnChainActivation(walletAddress);
        if (onChain && onChain.verified) {
          console.log('[Registration] On-chain check confirms node is registered despite client error:', onChain.node_id);
          const systemPseudonym = this.generateLightNodePseudonym(walletAddress);
          await AsyncStorage.setItem(`node_pseudonym_${activationCode}`, onChain.node_id || systemPseudonym);
          await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());
          return {
            success: true,
            nodeType: onChain.node_type || 'light',
            pseudonym: onChain.node_id || systemPseudonym,
            burnTxHash: burnTxHash || null,
            message: 'Node is already registered and active on blockchain.',
            quantumSecured: true,
            pendingRegistration: false,
            recoveredFromOnChain: true
          };
        }
      } catch (_) {
        // On-chain check itself failed — fall through to error response
      }

      return {
        success: false,
        error: error.message || 'Dilithium3 registration failed. Quantum signature is required.'
      };
    }
  }
  
  // Send node ping/heartbeat
  // PRODUCTION: Uses /api/v1/light-node/ping-response with HYBRID signature
  async pingNode(activationCode, walletAddress, nodeType, password) {
    try {
      const { signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');

      // Get pseudonym (stored during registration)
      const storedPseudonym = await AsyncStorage.getItem(`node_pseudonym_${activationCode}`);
      const nodeId = storedPseudonym || this.generateLightNodePseudonym(walletAddress);

      // Get backend URL — any synced node (scalable via discovery)
      const apiUrl = this.getRandomBootstrapNode();

      // Create challenge from timestamp (for signature)
      const challenge = `ping:${nodeId}:${Date.now()}`;

      // Build ML-DSA-65 signature (pure post-quantum, no Ed25519)
      let formattedSignature;

      if (!isDilithiumAvailable()) {
        throw new Error('Dilithium3 module required for node ping. Rebuild app with native module.');
      }

      // Load Dilithium3 keys (mandatory — no Ed25519 fallback)
      const dilithiumKeys = await this._walletDilithiumKeys(password);

      // Sign challenge with Dilithium3
      const dilithiumSig = await signWithDilithium(
        challenge,
        dilithiumKeys.secretKey,
        dilithiumKeys.publicKey,
        nodeId
      );
      formattedSignature = dilithiumSig;

      // Send ping via correct endpoint: GET /api/v1/light-node/ping-response
      const response = await fetch(
        `${apiUrl}/api/v1/light-node/ping-response?node_id=${encodeURIComponent(nodeId)}&challenge=${encodeURIComponent(challenge)}&signature=${encodeURIComponent(formattedSignature)}`,
        { method: 'GET' }
      );

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || `Ping failed: ${response.status}`);
      }

      // Store last ping time
      await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());

      return {
        success: true,
        timestamp: Date.now(),
        nextPingTime: result.next_ping_time,
        nextPingWindow: result.next_ping_window
      };

    } catch (error) {
      console.warn('[Ping] Heartbeat failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Claim accumulated rewards with blockchain integration
  // Works for ALL node types: Light, Full, Super, Genesis
  // Server validates pending rewards - client just sends claim request
  async claimRewards(nodeType, activationCode, walletAddress, password, serverPendingRewards = null, actualNodeId = null) {
    try {
      // Unified check for all node types via on-chain pending rewards (nanoQNC)
      if (serverPendingRewards !== null && serverPendingRewards <= 0) {
        return { success: false, message: 'No pending rewards' };
      }
      if (serverPendingRewards !== null && serverPendingRewards < 1_000_000_000) {
        return { success: false, message: 'Minimum claim amount is 1 QNC' };
      }
      
      let nodeId;
      if (actualNodeId) {
        nodeId = actualNodeId;
      } else {
        const genesisMatch = activationCode.match(/^QNET-BOOT-0*([1-5])-STRAP$/);
        if (genesisMatch) {
          const bootstrapId = genesisMatch[1].padStart(3, '0');
          nodeId = `genesis_node_${bootstrapId}`;
        } else {
          nodeId = `${nodeType}_${activationCode}`;
        }
      }
      
      // Load wallet for signing
      const walletData = await this.loadWallet(password);
      if (!walletData) {
        throw new Error('Failed to load wallet for signing');
      }
      
      // PURE DILITHIUM (F0.2): the reward claim is authorised ONLY by the ML-DSA-65 signature below over
      // "claim_rewards:{node_id}:{wallet_address}" (the node also matches the on-chain wallet + re-verifies
      // the merkle proof). Ed25519 is Solana-only and no longer sent on this QNet path.
      const message = `claim_rewards:${nodeId}:${walletAddress}`;

      // Dilithium3 signature — quantum-safe proof of node ownership (NIST FIPS 204)
      // Activation code is used as seed so the same keypair is deterministically recovered
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
        console.warn('[claimRewards] Dilithium signing failed (server will reject):', dilithiumErr.message);
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
      const claimResult = claimRes.data || {};
      if (!claimRes.ok) {
        throw new Error(claimResult.error || claimResult.message || 'Failed to claim rewards');
      }
      if (!claimResult.success) {
        throw new Error(claimResult.error || 'Claim failed on server');
      }
      
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
        epochsClaimed,
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
  // (contract address + per-token decimals are threaded through the send modal), so this
  // function only handles the native asset; any other symbol here is a caller bug.
  async sendTransaction(fromAddress, toAddress, amount, tokenSymbol, password) {
    try {
      // Route to appropriate network handler
      if (tokenSymbol === 'QNC') {
        return await this.sendQNC(toAddress, amount, password);
      } else if (tokenSymbol === 'SOL') {
        // Solana transactions not supported in this app
        throw new Error('Solana transactions are not supported. Use a Solana wallet.');
      } else {
        // QRC-20 tokens do not reach here — the UI calls qrc20Transfer(contract, ...) directly.
        throw new Error(`sendTransaction is for native QNC only; use qrc20Transfer for token ${tokenSymbol}`);
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Send QNC tokens to another address
  async sendQNC(toAddress, amount, password) {
    try {
      // Validate inputs - EON address: {19 chars}eon{15 chars}{8 checksum} = 45 chars
      if (!toAddress) {
        throw new Error('Recipient address is required');
      }

      // EON (45 chars, "eon" marker at offset 19, 8-char SHA3 checksum) or hex (64 chars).
      const isEonFormat = toAddress.length === 45 && toAddress.slice(19, 22) === 'eon';
      const isHexFormat = /^[0-9a-fA-F]{64}$/.test(toAddress);
      if (!isEonFormat && !isHexFormat) {
        throw new Error('Invalid address. EON (45 chars) or Hex (64 chars) required.');
      }
      if (isEonFormat) {
        // Reject a mistyped EON address BEFORE signing — checksum over the first 37 chars.
        const { sha3_256 } = require('js-sha3');
        const expectedCk = sha3_256(toAddress.slice(0, 37)).substring(0, 8).toLowerCase();
        if (toAddress.slice(37).toLowerCase() !== expectedCk) {
          throw new Error('Invalid recipient address (checksum mismatch)');
        }
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Amount must be a valid positive number');
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
      
      // Get QNet keypair for signing (Ed25519)
      const qnetKeypair = walletData.qnetKeypair;
      if (!qnetKeypair || !qnetKeypair.privateKey) {
        // Fallback to legacy secretKey if available
        if (!walletData.secretKey) {
          throw new Error('No signing key available in wallet');
        }
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
      const amountSmallest = Math.round(amount * 1_000_000_000);
      if (!Number.isSafeInteger(amountSmallest)) {
        throw new Error('Amount too large or imprecise'); // beyond 2^53 nano — would lose precision
      }
      const gasPrice = 10;   // nanoQNC/gas — matches node MIN_GAS_PRICE (fee = 10 * 10000 = 0.0001 QNC)
      const gasLimit = 10_000;

      const { signWithDilithium } = require('../crypto/DilithiumCrypto');

      // Sign + submit for a nonce. The canonical message MUST byte-match the node's
      // build_canonical_verify_message Transfer arm: "transfer:from:to:amount:nonce:gas_price:gas_limit".
      // signer_id = raw pubkey hex ⇒ wire format "dilithium_sig_{pk}_{b64([sig_len][SignedMessage][pk_len][pk])}",
      // which the node verifies via verify_user_tx_dilithium (open() under dilithium_public_key).
      const buildAndSubmit = async (txNonce) => {
        const message = `transfer:${fromAddress}:${toAddress}:${amountSmallest}:${txNonce}:${gasPrice}:${gasLimit}`;
        const dilSig = await signWithDilithium(message, dilSkHex, dilPkHex, dilPkHex);
        return this.submitSignedTx({
          from: fromAddress, to: toAddress, amount: amountSmallest,
          dilithium_signature: dilSig, dilithium_public_key: dilPkHex,
          gas_price: gasPrice, gas_limit: gasLimit, nonce: txNonce,
        });
      };

      // Local nonce → hedged submit; one retry with a chain-fresh nonce if the node rejects on drift.
      let txNonce = await this.resolveNonce(fromAddress);
      let result = await buildAndSubmit(txNonce);
      if (result && result.success === false && !result.tx_hash &&
          /nonce/i.test(`${result.error || ''} ${result.details || ''}`)) {
        txNonce = await this.resolveNonce(fromAddress, true);
        result = await buildAndSubmit(txNonce);
      }
      // Affirmative accept: require a real tx_hash (or explicit success). An ambiguous/empty 200 is
      // NOT a successful send — never show "sent" + deduct balance for a TX the node may have dropped.
      const accepted = !!(result && (result.tx_hash || result.success === true));
      if (!accepted) {
        const errorMsg = result && result.details
          ? `${result.error}: ${result.details}`
          : (result && result.error) || 'Node did not acknowledge the transaction';
        console.warn('[SEND] tx not accepted:', errorMsg);
        throw new Error(errorMsg);
      }
      this._bumpNonce(fromAddress, txNonce);
      return {
        success: true, txHash: result.tx_hash,
        from: fromAddress, to: toAddress, amount, timestamp: Date.now(),
      };
    } catch (error) {
      console.warn('[WalletManager] Send QNC error:', error.message || error);
      throw error;
    }
  }

  // ===========================================================================
  // QRC-20 SDK — client-side ContractCall/ContractDeploy convenience wrappers
  // ===========================================================================
  // Same wallet-load, ML-DSA-65 signer, local-nonce and hedged-submit path as
  // sendQNC. The node builds tx.data server-side from the request fields, so the
  // signature MUST bind the EXACT byte string it will reproduce:
  //   ContractCall   canonical: contract_call:{from}:{sha3_256_hex(dataStr)}:{nonce}
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
  // { success, tx_hash, ... } JSON; throws only on an unaffirmed submit.
  async buildContractCall(contractAddress, method, args, password, opts = {}) {
    if (!contractAddress || !method) throw new Error('contractAddress and method are required');
    const argList = Array.isArray(args) ? args : [];
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);

    const gasPrice = opts.gasPrice != null ? opts.gasPrice : 10;   // nanoQNC/gas — node MIN_GAS_PRICE
    const gasLimit = opts.gasLimit != null ? opts.gasLimit : 10_000; // node call min gas_limit

    const { signWithDilithium } = require('../crypto/DilithiumCrypto');
    const { sha3_256 } = require('js-sha3');

    const buildAndSubmit = async (txNonce) => {
      // Byte-exact match to the node's json! serialization: serde_json (preserve_order OFF)
      // sorts object keys, so the keys MUST be alphabetical — args, contract, method.
      const dataStr = JSON.stringify({ args: argList, contract: contractAddress, method });
      const dataHash = sha3_256(dataStr); // hex; matches Rust Sha3_256::digest(tx.data)
      const message = `contract_call:${from}:${dataHash}:${txNonce}`;
      const dilSig = await signWithDilithium(message, dilSkHex, dilPkHex, dilPkHex);
      const res = await this._hedged('/api/v1/contract/call', {
        method: 'POST', timeoutMs: 5000, hedgeMs: 900,
        body: {
          from, contract_address: contractAddress, method, args: argList,
          gas_price: gasPrice, gas_limit: gasLimit, nonce: txNonce,
          dilithium_signature: dilSig, dilithium_public_key: dilPkHex,
        },
      });
      return res.data || {};
    };

    // Local nonce → hedged submit; one retry with a chain-fresh nonce on drift (mirrors sendQNC).
    let txNonce = await this.resolveNonce(from);
    let result = await buildAndSubmit(txNonce);
    if (result && result.success === false && !result.tx_hash &&
        /nonce/i.test(`${result.error || ''} ${result.details || ''}`)) {
      txNonce = await this.resolveNonce(from, true);
      result = await buildAndSubmit(txNonce);
    }
    const accepted = !!(result && (result.tx_hash || result.success === true));
    if (!accepted) {
      const errorMsg = result && result.details
        ? `${result.error}: ${result.details}`
        : (result && result.error) || 'Node did not acknowledge the contract call';
      console.warn('[QRC20] call not accepted:', errorMsg);
      throw new Error(errorMsg);
    }
    this._bumpNonce(from, txNonce);
    return result;
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
  // canonical base-10 integer string that serde serializes byte-identically here and node-side.
  _amt(amount) {
    if (typeof amount === 'string') {
      if (!/^\d+$/.test(amount)) throw new Error('amount must be a non-negative integer string');
      return amount;
    }
    if (typeof amount === 'bigint') {
      if (amount < 0n) throw new Error('amount must be non-negative');
      return amount.toString();
    }
    if (typeof amount === 'number') {
      if (!Number.isInteger(amount) || amount < 0) throw new Error('amount must be a non-negative integer');
      if (!Number.isSafeInteger(amount)) throw new Error('amount exceeds 2^53 — pass a string for full u64 exactness');
      return String(amount);
    }
    throw new Error('amount must be a string, number, or bigint');
  }
  async qrc20Transfer(contract, to, amount, password, opts) {
    return this.buildContractCall(contract, 'transfer', [to, this._amt(amount)], password, opts);
  }
  async qrc20Approve(contract, spender, amount, password, opts) {
    return this.buildContractCall(contract, 'approve', [spender, this._amt(amount)], password, opts);
  }
  async qrc20TransferFrom(contract, from, to, amount, password, opts) {
    return this.buildContractCall(contract, 'transferFrom', [from, to, this._amt(amount)], password, opts);
  }
  async qrc20Mint(contract, to, amount, password, opts) {
    return this.buildContractCall(contract, 'mint', [to, this._amt(amount)], password, opts);
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
    return this.buildContractCall(contract, 'mint', [to, this._tokenId(tokenId)], password, opts);
  }
  async nftTransfer(contract, to, tokenId, password, opts) {
    return this.buildContractCall(contract, 'transfer', [to, this._tokenId(tokenId)], password, opts);
  }
  async nftApprove(contract, spender, tokenId, password, opts) {
    return this.buildContractCall(contract, 'approve', [spender, this._tokenId(tokenId)], password, opts);
  }
  async nftTransferFrom(contract, from, to, tokenId, password, opts) {
    return this.buildContractCall(contract, 'transferFrom', [from, to, this._tokenId(tokenId)], password, opts);
  }

  // Deploy a QRC-20 token via the node's /api/v1/token/deploy endpoint. The node
  // derives the on-chain contract address (derive_contract_address(from, nonce)) and
  // builds tx.data itself, so the signature binds the canonical deploy message it
  // reproduces: contract_deploy:{from}:{code_hash}:{nonce} with
  //   code_hash = sha3_256_hex("QRC20:" + name + ":" + symbol).
  // NOTE: the current node token/deploy handler hardcodes tx.data WITHOUT the
  // mintable/burnable flags, so those keys are inert until the node forwards them
  // (state.rs already reads them from tx.data). We send them anyway for
  // forward-compatibility; today a token deploys as immutable-supply.
  async deployToken({ name, symbol, decimals = 9, initialSupply, mintable = false, burnable = false }, password, opts = {}) {
    if (!name || !symbol) throw new Error('name and symbol are required');
    if (!(initialSupply > 0)) throw new Error('initialSupply must be greater than 0');
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);

    const { signWithDilithium } = require('../crypto/DilithiumCrypto');
    const { sha3_256 } = require('js-sha3');

    const buildAndSubmit = async (txNonce) => {
      // code_hash the node signs over: sha3("QRC20:"+name+":"+symbol) — NIST FIPS 202.
      const codeHash = sha3_256(`QRC20:${name}:${symbol}`);
      const message = `contract_deploy:${from}:${codeHash}:${txNonce}`;
      const dilSig = await signWithDilithium(message, dilSkHex, dilPkHex, dilPkHex);
      const res = await this._hedged('/api/v1/token/deploy', {
        method: 'POST', timeoutMs: 5000, hedgeMs: 900,
        body: {
          from, name, symbol, decimals, initial_supply: initialSupply, nonce: txNonce,
          mintable, burnable, // inert on the current node handler (see NOTE above)
          dilithium_signature: dilSig, dilithium_public_key: dilPkHex,
        },
      });
      return res.data || {};
    };

    let txNonce = await this.resolveNonce(from);
    let result = await buildAndSubmit(txNonce);
    if (result && result.success === false && !result.tx_hash &&
        /nonce/i.test(`${result.error || ''} ${result.details || ''}`)) {
      txNonce = await this.resolveNonce(from, true);
      result = await buildAndSubmit(txNonce);
    }
    const accepted = !!(result && (result.tx_hash || result.success === true));
    if (!accepted) {
      const errorMsg = result && result.details
        ? `${result.error}: ${result.details}`
        : (result && result.error) || 'Node did not acknowledge the token deploy';
      console.warn('[QRC20] deploy not accepted:', errorMsg);
      throw new Error(errorMsg);
    }
    this._bumpNonce(from, txNonce);
    return result;
  }

  // Deploy a QRC-721 (NFT) collection. Mirrors deployToken's ContractDeploy path exactly:
  // the node derives the on-chain contract address (derive_contract_address(from, nonce)),
  // builds tx.data server-side as {"qrc721":true,"name":..,"symbol":..}, and the value-TX gate
  // rebuilds the SAME canonical deploy message this signs — contract_deploy:{from}:{code_hash}:{nonce}
  // with code_hash = sha3_256_hex("QRC721:"+name+":"+symbol) — then binds the ML-DSA-65 key to `from`.
  // The digest prefix mirrors the node's token/deploy scheme (QRC20:) with the qrc721 discriminant;
  // it must byte-match the node's nft/deploy handler's code_hash construction (name/symbol UTF-8,
  // ':' separators, NIST FIPS 202).
  //
  // NOTE: this targets a dedicated /api/v1/nft/deploy endpoint. The current node exposes only
  // token/deploy (hardcoded qrc20) and contract/deploy (WASM); neither emits the qrc721 tx.data
  // that qnet-state's deploy branch parses. Until that handler lands, this wrapper is byte-correct
  // but will 404 — see the SDK stage report. NFT *method calls* (nftMint/Transfer/Approve/
  // TransferFrom) go through the live contract/call path and work today.
  async deployNftCollection({ name, symbol }, password, opts = {}) {
    if (!name || !symbol) throw new Error('name and symbol are required');
    const { from, dilPkHex, dilSkHex } = await this._loadContractSigner(password);

    const { signWithDilithium } = require('../crypto/DilithiumCrypto');
    const { sha3_256 } = require('js-sha3');

    const buildAndSubmit = async (txNonce) => {
      // code_hash the node signs over: sha3("QRC721:"+name+":"+symbol) — NIST FIPS 202.
      const codeHash = sha3_256(`QRC721:${name}:${symbol}`);
      const message = `contract_deploy:${from}:${codeHash}:${txNonce}`;
      const dilSig = await signWithDilithium(message, dilSkHex, dilPkHex, dilPkHex);
      const res = await this._hedged('/api/v1/nft/deploy', {
        method: 'POST', timeoutMs: 5000, hedgeMs: 900,
        body: {
          from, name, symbol, nonce: txNonce,
          dilithium_signature: dilSig, dilithium_public_key: dilPkHex,
        },
      });
      return res.data || {};
    };

    let txNonce = await this.resolveNonce(from);
    let result = await buildAndSubmit(txNonce);
    if (result && result.success === false && !result.tx_hash &&
        /nonce/i.test(`${result.error || ''} ${result.details || ''}`)) {
      txNonce = await this.resolveNonce(from, true);
      result = await buildAndSubmit(txNonce);
    }
    const accepted = !!(result && (result.tx_hash || result.success === true));
    if (!accepted) {
      const errorMsg = result && result.details
        ? `${result.error}: ${result.details}`
        : (result && result.error) || 'Node did not acknowledge the NFT collection deploy';
      console.warn('[NFT] deploy not accepted:', errorMsg);
      throw new Error(errorMsg);
    }
    this._bumpNonce(from, txNonce);
    return result;
  }

  // Check if wallet exists and is valid
  async walletExists() {
    try {
      const vaultDataStr = await AsyncStorage.getItem('qnet_wallet');
      if (!vaultDataStr) {
        return false;
      }
      
      // Try to parse to check if data is valid JSON
      try {
        JSON.parse(vaultDataStr);
        return true;
      } catch (parseError) {
        // Corrupted data - clean it up
        // console.log('Corrupted wallet data detected, cleaning up...');
        await AsyncStorage.removeItem('qnet_wallet');
        await AsyncStorage.removeItem('qnet_wallet_address');
        return false;
      }
    } catch (error) {
      // console.error('Error checking wallet existence:', error);
      return false;
    }
  }
  
  // Quick password verification (faster than full decryption)
  async verifyPassword(password) {
    await this._loadRateLimitState();
    if (this._lockoutUntil > Date.now()) return false;

    try {
      const vaultDataStr = await AsyncStorage.getItem('qnet_wallet');
      if (!vaultDataStr) return false;

      const vaultData = JSON.parse(vaultDataStr);
      try {
        let plaintext;
        if (vaultData.version === 3 || vaultData.version === 2) {
          plaintext = await this._decryptGCM(vaultData, password);
        } else if (vaultData.salt) {
          plaintext = await this._decryptCBC(vaultData, password);
        } else {
          throw new Error('Unsupported vault format');
        }
        JSON.parse(plaintext);
        // For v2/v3 vaults: key was already cached inside _decryptGCM above.
        // For v1 CBC vaults: skip caching — loadWallet will use _decryptCBC (CryptoJS)
        // and migration creates a new salt, so a pre-cached key is never reused.
        await this._resetRateLimit();
        return true;
      } catch {
        this._clearCachedKey();
        await this._recordFailedAttempt();
        return false;
      }
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
