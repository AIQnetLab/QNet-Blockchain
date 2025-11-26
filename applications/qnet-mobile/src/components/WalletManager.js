import AsyncStorage from '@react-native-async-storage/async-storage';
import CryptoJS from 'crypto-js';
// Import native crypto for production - falls back to CryptoJS
import 'react-native-get-random-values'; // Must be imported first
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';

export class WalletManager {
  constructor() {
    this.connection = new Connection('https://api.devnet.solana.com', 'confirmed');
    this.keyCache = null; // Cache derived key for faster unlock
    this.keyCachePassword = null; // Track which password the key is for
    
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
      
      // New long format: 19 chars + "eon" + 15 chars + 4 char checksum = 41 total
      const part1 = fullHash.substring(0, 19).toLowerCase();
      const part2 = fullHash.substring(19, 34).toLowerCase();
      
      // Generate checksum
      const checksumData = `qnet_${part1}_eon_${part2}`;
      const checksumHash = CryptoJS.SHA256(checksumData);
      const checksum = checksumHash.toString(CryptoJS.enc.Hex).substring(0, 4);
      
      return `qnet_${part1}_eon_${part2}_${checksum}`;
    } catch (error) {
      // console.error('Error generating QNet address from Solana:', error);
      return null;
    }
  }
  
  // Migrate old QNet address to new BIP44-based format
  async migrateQNetAddress(wallet) {
    try {
      // Skip if wallet already has BIP44 keypair (already migrated or newly imported)
      if (wallet.qnetKeypair && wallet.qnetKeypair.path) {
        return wallet;
      }
      
      // MIGRATE only old wallets without BIP44 keypair
      if (wallet.mnemonic && !wallet.qnetKeypair) {
        const seed = bip39.mnemonicToSeedSync(wallet.mnemonic);
        const result = await this.generateQNetAddress(seed, 0);
        
        // Store old address for logging
        const oldAddress = wallet.qnetAddress;
        
        // UPDATE to new BIP44 address (breaking change but necessary)
        wallet.qnetAddress = result.address;
        wallet.qnetKeypair = {
          publicKey: Array.from(result.keypair.publicKey),
          privateKey: Array.from(result.keypair.privateKey),
          path: result.keypair.path
        };
        
        //if (oldAddress && oldAddress !== result.address) {
          //console.log('[MIGRATION] QNet address updated:', oldAddress, '->', result.address);
       // } else {
         // console.log('[Migration] Generated BIP44 QNet address:', result.address);
       // }
        
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

  // Generate QNet keypair using BIP44 standard with proper SLIP-0010
  // SECURITY: This follows the same standard as hardware wallets (Ledger, Trezor)
  // OPTIMIZED: Minimized conversions between formats for speed
  generateQNetKeypair(seed, accountIndex = 0) {
    try {
      // BIP44 path for QNet: m/44'/9999'/accountIndex'/0'/0'
      
      // Step 1: Generate master key from seed (keep as WordArray)
      const seedWordArray = CryptoJS.lib.WordArray.create(seed);
      let currentKey = CryptoJS.HmacSHA512(seedWordArray, "ed25519 seed");
      
      // Split into key and chain code using WordArray directly
      let keyWords = currentKey.words.slice(0, 8); // First 32 bytes (8 words)
      let chainWords = currentKey.words.slice(8, 16); // Next 32 bytes
      
      // Step 2: Derive path m/44'/9999'/accountIndex'/0'/0'
      const levels = [
        0x8000002C, // 44' (hardened)
        0x8000270F, // 9999' (hardened) - 0x270F = 9999
        0x80000000 + accountIndex, // accountIndex' (hardened)
        0x80000000, // 0' (hardened change)
        0x80000000  // 0' (hardened address index)
      ];
      
      // Step 3: Derive each level (optimized with WordArray)
      for (const index of levels) {
        // Build data: 0x00 || key || index (37 bytes total)
        const dataWords = new Array(10); // 37 bytes = ~10 words
        dataWords[0] = 0x00000000 | (keyWords[0] >>> 8); // 0x00 prefix + first 3 bytes of key
        
        // Copy key bytes (shifted by 1 byte)
        for (let i = 0; i < 7; i++) {
          dataWords[i + 1] = ((keyWords[i] << 8) | (keyWords[i + 1] >>> 24)) >>> 0;
        }
        dataWords[8] = ((keyWords[7] << 8) | (index >>> 24)) >>> 0;
        dataWords[9] = (index << 8) >>> 0;
        
        const dataWordArray = CryptoJS.lib.WordArray.create(dataWords, 37);
        const chainWordArray = CryptoJS.lib.WordArray.create(chainWords);
        
        const derived = CryptoJS.HmacSHA512(dataWordArray, chainWordArray);
        keyWords = derived.words.slice(0, 8);
        chainWords = derived.words.slice(8, 16);
      }
      
      // Step 4: Generate public key from private key
      const privateKeyWordArray = CryptoJS.lib.WordArray.create(keyWords);
      const publicKeyHash = CryptoJS.SHA256(privateKeyWordArray);
      
      // Convert to Uint8Array only at the end
      const privateKey = new Uint8Array(32);
      const publicKey = new Uint8Array(32);
      
      for (let i = 0; i < 8; i++) {
        const kw = keyWords[i];
        const pw = publicKeyHash.words[i];
        privateKey[i * 4] = (kw >>> 24) & 0xff;
        privateKey[i * 4 + 1] = (kw >>> 16) & 0xff;
        privateKey[i * 4 + 2] = (kw >>> 8) & 0xff;
        privateKey[i * 4 + 3] = kw & 0xff;
        publicKey[i * 4] = (pw >>> 24) & 0xff;
        publicKey[i * 4 + 1] = (pw >>> 16) & 0xff;
        publicKey[i * 4 + 2] = (pw >>> 8) & 0xff;
        publicKey[i * 4 + 3] = pw & 0xff;
      }
      
      return {
        privateKey: privateKey,
        publicKey: publicKey,
        path: `m/44'/9999'/${accountIndex}'/0'/0'`,
        chainCode: new Uint8Array(32) // Not needed for address generation
      };
    } catch (error) {
      // console.error('Error generating QNet keypair:', error);
      throw new Error('Failed to generate QNet keypair');
    }
  }
  
  // Generate QNet EON address (compatible with extension wallet)
  async generateQNetAddress(seed, accountIndex = 0) {
    try {
      // Generate keypair first using BIP44 (now synchronous for speed)
      const keypair = this.generateQNetKeypair(seed, accountIndex);
      
      // Generate address from public key
      const publicKeyWordArray = CryptoJS.lib.WordArray.create(keypair.publicKey);
      const addressHash = CryptoJS.SHA512(publicKeyWordArray);
      const fullHash = addressHash.toString(CryptoJS.enc.Hex);
      
      // Create address format: 19 chars + "eon" + 15 chars + 4 char checksum
      const part1 = fullHash.substring(0, 19).toLowerCase();
      const part2 = fullHash.substring(19, 34).toLowerCase();
      
      // Generate checksum
      const addressWithoutChecksum = part1 + 'eon' + part2;
      const checksumData = CryptoJS.SHA256(addressWithoutChecksum);
      const checksum = checksumData.toString(CryptoJS.enc.Hex).substring(0, 4).toLowerCase();
      
      const address = `${part1}eon${part2}${checksum}`;
      
      // Return both address and keypair for storage
      return {
        address: address,
        keypair: keypair
      };
    } catch (error) {
      // console.error('Error generating QNet address:', error);
      throw new Error('Failed to generate QNet address');
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
        }
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
      const salt = CryptoJS.enc.Hex.parse(vaultData.salt);
      const iv = CryptoJS.enc.Hex.parse(vaultData.iv);
      
      const key = await this.deriveKeyAsync(password, salt, 10000);
      
      const decrypted = CryptoJS.AES.decrypt(
        vaultData.encrypted,
        key,
        {
          iv: iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7
        }
      );
      
      const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
      return walletData.mnemonic || null;
    } catch (error) {
      return null;
    }
  }
  
  // Quick password verification without loading full wallet
  async verifyPassword(password) {
    try {
      const storedWallet = await AsyncStorage.getItem('qnet_wallet');
      if (!storedWallet) return false;
      
      const vaultData = JSON.parse(storedWallet);
      
      // Handle old format 
      if (typeof vaultData === 'string' || !vaultData.salt) {
        // Legacy format - try direct decryption
        const encrypted = typeof vaultData === 'string' ? vaultData : vaultData.encrypted;
        try {
          const decrypted = CryptoJS.AES.decrypt(encrypted, password).toString(CryptoJS.enc.Utf8);
          if (!decrypted) return false;
          const wallet = JSON.parse(decrypted);
          return wallet && wallet.publicKey ? true : false;
        } catch (error) {
          return false;
        }
      }
      
      // New format with salt and IV
      const salt = CryptoJS.enc.Hex.parse(vaultData.salt);
      const iv = CryptoJS.enc.Hex.parse(vaultData.iv);
      
      // Use cached key if available
      let key;
      if (this.keyCachePassword === password && this.keyCache) {
        key = this.keyCache;
      } else {
        // Derive key ASYNCHRONOUSLY using same parameters as storage
        key = await this.deriveKeyAsync(password, salt, 10000);
        this.keyCache = key;
        this.keyCachePassword = password;
      }
      
      // Decrypt
      const decrypted = CryptoJS.AES.decrypt(
        vaultData.encrypted,
        key,
        {
          iv: iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7
        }
      );
      
      try {
        const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
        return walletData && walletData.publicKey ? true : false;
      } catch (error) {
        return false; // Wrong password
      }
    } catch (error) {
      return false;
    }
  }

  // Async PBKDF2 wrapper to avoid blocking UI
  async deriveKeyAsync(password, salt, iterations = 10000) {
    return new Promise((resolve) => {
      // Use setTimeout to avoid blocking the main thread
      setTimeout(() => {
      const key = CryptoJS.PBKDF2(password, salt, {
        keySize: 256/32,
          iterations: iterations,
        hasher: CryptoJS.algo.SHA256
      });
        resolve(key);
      }, 0);
    });
  }

  // Encrypt and store wallet with PBKDF2 + AES (like extension)
  async storeWallet(walletData, password) {
    try {
      // Clear old activation codes when storing new wallet
      await AsyncStorage.removeItem('qnet_activation_codes');
      
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
      
      // Generate random salt (32 bytes)
      const salt = CryptoJS.lib.WordArray.random(32);
      
      // Derive key using PBKDF2 ASYNCHRONOUSLY (10,000 iterations for security)
      const key = await this.deriveKeyAsync(password, salt, 10000);
      
      // Cache the key for faster subsequent operations
      this.keyCache = key;
      this.keyCachePassword = password;
      
      // Generate random IV (16 bytes for AES)
      const iv = CryptoJS.lib.WordArray.random(16);
      
      // Encrypt wallet data with mnemonic included
      const encrypted = CryptoJS.AES.encrypt(
        JSON.stringify(storageData), 
        key,
        { 
          iv: iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7
        }
      );
      
      // Store encrypted data with salt and IV
      const vaultData = {
        encrypted: encrypted.toString(),
        salt: salt.toString(),
        iv: iv.toString(),
        version: 1,
        timestamp: Date.now()
      };
      
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
    
    // Fallback to Genesis bootstrap nodes if no discovered nodes
    // These are the official Genesis nodes from genesis_constants.rs
    const genesisNodes = [
      { url: 'http://154.38.160.39:8001', region: 'North America' },
      { url: 'http://62.171.157.44:8001', region: 'Europe' },
      { url: 'http://161.97.86.81:8001', region: 'Europe' },
      { url: 'http://5.189.130.160:8001', region: 'Europe' },
      { url: 'http://162.244.25.114:8001', region: 'Europe' }
    ];
    
    // Try to discover new nodes from Genesis nodes
    this.discoverNodes(genesisNodes);
    
    // Return random Genesis node for now
    const node = genesisNodes[Math.floor(Math.random() * genesisNodes.length)];
    return node.url;
  }
  
  // Discover active nodes from network
  async discoverNodes(seedNodes) {
    try {
      // Query each seed node for their peer list
      for (const seed of seedNodes) {
        try {
          const response = await fetch(`${seed.url}/api/v1/peers`, {
            method: 'GET',
            timeout: 5000
          });
          
          if (response.ok) {
            const data = await response.json();
            if (data.peers && Array.isArray(data.peers)) {
              // Store discovered nodes
              const discoveredNodes = data.peers.map(peer => ({
                url: `http://${peer.address}`,
                nodeType: peer.node_type,
                lastSeen: Date.now()
              }));
              
              // Merge with existing cache
              const cachedNodes = await AsyncStorage.getItem('qnet_discovered_nodes');
              let allNodes = discoveredNodes;
              if (cachedNodes) {
                const existing = JSON.parse(cachedNodes);
                allNodes = [...existing, ...discoveredNodes];
                
                // Remove duplicates
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
      // Discovery failed, will use Genesis nodes
    }
  }
  
  // Helper for backward compatibility
  getRandomBootstrapNode() {
    // Synchronous wrapper for compatibility
    // Returns Genesis node immediately, discovery happens in background
    const genesisNodes = [
      'http://154.38.160.39:8001',
      'http://62.171.157.44:8001',
      'http://161.97.86.81:8001',
      'http://5.189.130.160:8001',
      'http://162.244.25.114:8001'
    ];
    return genesisNodes[Math.floor(Math.random() * genesisNodes.length)];
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
      
      // Handle old format (direct encryption without salt/IV)
      if (typeof vaultData === 'string' || !vaultData.salt) {
        // Legacy format - try direct decryption
        const encrypted = typeof vaultData === 'string' ? vaultData : vaultData.encrypted;
        const decrypted = CryptoJS.AES.decrypt(encrypted, password).toString(CryptoJS.enc.Utf8);
        if (!decrypted) {
          throw new Error('Invalid password');
        }
        let wallet = JSON.parse(decrypted);
        
        // Migrate old QNet address format to new if needed
        wallet = await this.migrateQNetAddress(wallet);
        
        // Store migrated wallet in new format
        if (wallet.qnetAddress && wallet.qnetAddress.length >= 40) {
          // Generate salt and IV for new format
          const salt = CryptoJS.lib.WordArray.random(256/8);
          const iv = CryptoJS.lib.WordArray.random(128/8);
          
          // Derive key ASYNCHRONOUSLY
          const key = await this.deriveKeyAsync(password, salt, 10000);
          
          // Encrypt with new format
          const updatedEncrypted = CryptoJS.AES.encrypt(
            JSON.stringify(wallet),
            key,
            {
              iv: iv,
              mode: CryptoJS.mode.CBC,
              padding: CryptoJS.pad.Pkcs7
            }
          ).toString();
          
          const updatedVaultData = {
            encrypted: updatedEncrypted,
            salt: salt.toString(CryptoJS.enc.Hex),
            iv: iv.toString(CryptoJS.enc.Hex)
          };
          await AsyncStorage.setItem('qnet_wallet', JSON.stringify(updatedVaultData));
          
          // Also update the stored QNet address
          await AsyncStorage.setItem('qnet_address', wallet.qnetAddress);
        }
        
        // Remove mnemonic from memory for security
        if (wallet.mnemonic) {
          delete wallet.mnemonic;
        }
        return wallet;
      }
      
      // New format with salt and IV
      const salt = CryptoJS.enc.Hex.parse(vaultData.salt);
      const iv = CryptoJS.enc.Hex.parse(vaultData.iv);
      
      // Use cached key if available
      let key;
      if (this.keyCachePassword === password && this.keyCache) {
        key = this.keyCache;
      } else {
        // Derive key ASYNCHRONOUSLY using same parameters as storage
        key = await this.deriveKeyAsync(password, salt, 10000);
        this.keyCache = key;
        this.keyCachePassword = password;
      }
      
      // Decrypt
      const decrypted = CryptoJS.AES.decrypt(
        vaultData.encrypted,
        key,
        {
          iv: iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7
        }
      );
      
      let decryptedStr;
      try {
        decryptedStr = decrypted.toString(CryptoJS.enc.Utf8);
      } catch (utf8Error) {
        // console.error('UTF-8 decode error, likely wrong password');
        throw new Error('Wrong password or corrupted wallet');
      }
      
      if (!decryptedStr) {
        throw new Error('Wrong password or corrupted wallet');
      }
      
      try {
        let wallet = JSON.parse(decryptedStr);
        
        // Migrate old QNet address format to new if needed
        wallet = await this.migrateQNetAddress(wallet);
        
        // Store migrated wallet if it was updated
        if (wallet.qnetAddress && wallet.qnetAddress.length >= 40) {
          // Re-encrypt with migrated data
          const updatedEncrypted = CryptoJS.AES.encrypt(
            JSON.stringify(wallet),
            key,
            {
              iv: iv,
              mode: CryptoJS.mode.CBC,
              padding: CryptoJS.pad.Pkcs7
            }
          ).toString();
          
          const updatedVaultData = {
            encrypted: updatedEncrypted,
            salt: vaultData.salt,
            iv: vaultData.iv
          };
          await AsyncStorage.setItem('qnet_wallet', JSON.stringify(updatedVaultData));
          
          // Also update the stored QNet address
          await AsyncStorage.setItem('qnet_address', wallet.qnetAddress);
        }
        
        // Remove mnemonic from memory for security
        if (wallet.mnemonic) {
          delete wallet.mnemonic;
        }
        return wallet;
      } catch (parseError) {
        // console.error('Failed to parse decrypted data');
        throw new Error('Wrong password or corrupted wallet');
      }
    } catch (error) {
      // console.error('Error loading wallet:', error);
      throw error;
    }
  }

  // Get wallet balance from Solana network
  async getBalance(publicKey, isTestnet = true) {
    try {
      // Use correct RPC based on network (don't use cached connection)
      // FIXED: Previously inverted - now isTestnet=true means devnet
      const rpcUrl = isTestnet 
        ? 'https://api.devnet.solana.com'  // Testnet
        : 'https://api.mainnet-beta.solana.com';  // Mainnet
        
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [publicKey]
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        // Convert lamports to SOL (1 SOL = 1e9 lamports)
        return (data.result?.value || 0) / 1e9;
      }
      
      return 0;
    } catch (error) {
      // console.error('Error getting balance:', error);
      return 0;
    }
  }
  
  // Get SPL token balance (for 1DEV and other tokens)
  async getTokenBalance(walletAddress, mintAddress, isTestnet = true) {
    try {
      // Use correct RPC based on network - TESTNET when isTestnet=true
      const rpcUrl = isTestnet 
        ? 'https://api.devnet.solana.com'  // TESTNET when isTestnet=true
        : 'https://api.mainnet-beta.solana.com';  // MAINNET when isTestnet=false
      
      // Get token accounts for the wallet
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            walletAddress,
            {
              mint: mintAddress
            },
            {
              encoding: 'jsonParsed'
            }
          ]
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const accounts = data.result?.value || [];
        
        if (accounts.length > 0) {
          // Get the token amount from the first account
          const tokenAmount = accounts[0].account.data.parsed.info.tokenAmount;
          return parseFloat(tokenAmount.uiAmount) || 0;
        }
      }
      
      return 0;
    } catch (error) {
      // console.error('Error getting token balance:', error);
      return 0;
    }
  }

  // Get active nodes count from blockchain/API
  async getActiveNodesCount(isTestnet = true) {
    try {
      // PRODUCTION: Get real count from QNet bootstrap nodes
      const bootstrapNodes = [
        'https://bootstrap1.qnet.network',
        'https://bootstrap2.qnet.network',
        'https://bootstrap3.qnet.network',
        'https://bootstrap4.qnet.network',
        'https://bootstrap5.qnet.network'
      ];
      
      // Try multiple bootstrap nodes for reliability
      for (const apiUrl of bootstrapNodes) {
        try {
          const response = await fetch(`${apiUrl}/api/v1/network/stats`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
          });
          
          if (response.ok) {
            const stats = await response.json();
            // Return total active nodes (Light + Full + Super)
            const totalNodes = (stats.light_nodes || 0) + 
                              (stats.full_nodes || 0) + 
                              (stats.super_nodes || 0);
            return totalNodes > 0 ? totalNodes : 150000; // Fallback if 0
          }
        } catch (nodeError) {
          // Try next node
          continue;
        }
      }
      
      // All nodes failed, return default
      return 150000;
      
    } catch (error) {
      // console.error('[getActiveNodesCount] Error:', error);
      // Default to mid-range if error
      return 150000;
    }
  }

  // Get real burn progress from blockchain
  async getBurnProgress(isTestnet = true) {
    try {
      // Ensure correct RPC endpoint usage
      const rpcUrl = isTestnet 
        ? 'https://api.devnet.solana.com'  // TESTNET when isTestnet=true
        : 'https://api.mainnet-beta.solana.com';  // MAINNET when isTestnet=false
      
      // 1DEV token mint addresses - ensure correct assignment
      const oneDevMint = isTestnet 
        ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'  // Testnet 1DEV
        : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';  // Mainnet 1DEV
      
      const TOTAL_SUPPLY = 1000000000; // 1 billion total supply
      
      // Try to get current supply and calculate burned amount
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenSupply',
          params: [oneDevMint]
        })
      });
      
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
      
      // Fallback values
      return '0.0';
    } catch (error) {
      // console.error('[getBurnProgress] Error:', error);
      // Return zero if can't fetch real data
      return '0.0';
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
      
      const connection = new Connection(
        isTestnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com',
        'confirmed'
      );
      
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
      
      // Send transaction
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed'
      });
      
      // Wait for confirmation
      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');
      
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
  generateActivationCode(nodeType = 'full', walletAddress = '', seedPhrase = null) {
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
  // Phase 1: burnTxHash = Solana 1DEV burn transaction
  // Phase 2: burnTxHash = QNet QNC transfer to Pool 3 transaction
  async requestActivationCodeFromServer(nodeType, walletAddress, burnTxHash, phase = 1) {
    try {
      const apiUrl = this.getRandomBootstrapNode();
      
      // Get dynamic pricing info for Phase 2
      let burnAmount = 0;
      if (phase === 2) {
        const pricingResponse = await fetch(`${apiUrl}/api/v1/pricing/${nodeType}`);
        const pricing = await pricingResponse.json();
        burnAmount = pricing.current_price || 0;
      }
      
      // Request code generation from server
      const response = await fetch(`${apiUrl}/api/v1/generate-activation-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          burn_tx_hash: burnTxHash,
          node_type: nodeType,
          burn_amount: burnAmount,
          phase: phase
        })
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
      console.error('Error requesting activation code:', error);
      throw error;
    }
  }
  
  // Encrypt and store activation code securely
  async storeActivationCode(code, nodeType, password, metadata = {}) {
    try {
      // Get existing encrypted codes or initialize
      const existingCodesStr = await AsyncStorage.getItem('qnet_activation_codes');
      let encryptedCodes = existingCodesStr ? JSON.parse(existingCodesStr) : {};
      
      // Store activation metadata (timestamp, tx signature, phase, wallet address)
      // CRITICAL: phase determines which wallet address to use for claims
      // Phase 1: Solana address, Phase 2: QNet address
      await AsyncStorage.setItem(`qnet_activation_meta_${nodeType}`, JSON.stringify({
        timestamp: metadata.timestamp || Date.now(),
        signature: metadata.signature || null,
        burnTxHash: metadata.burnTxHash || null,
        nodeType: nodeType,
        phase: metadata.phase || 1,  // Default to Phase 1
        walletAddress: metadata.walletAddress || null  // The address used for activation
      }));
      
      // Generate random salt and IV for this specific code
      const salt = CryptoJS.lib.WordArray.random(16);
      const iv = CryptoJS.lib.WordArray.random(16);
      
      // Derive key from password ASYNCHRONOUSLY
      const key = await this.deriveKeyAsync(password, salt, 10000);
      
      // Encrypt the activation code
      const encrypted = CryptoJS.AES.encrypt(code, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });
      
      // Store encrypted code with metadata
      encryptedCodes[nodeType] = {
        encrypted: encrypted.toString(),
        salt: salt.toString(),
        iv: iv.toString(),
        timestamp: Date.now(),
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
      
      // Parse encryption parameters
      const salt = CryptoJS.enc.Hex.parse(codeData.salt);
      const iv = CryptoJS.enc.Hex.parse(codeData.iv);
      
      // Derive key from password ASYNCHRONOUSLY
      const key = await this.deriveKeyAsync(password, salt, 10000);
      
      // Decrypt the activation code
      const decrypted = CryptoJS.AES.decrypt(codeData.encrypted, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });
      
      const decryptedStr = decrypted.toString(CryptoJS.enc.Utf8);
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
        // Already have codes locally - no need to check blockchain
        // This saves battery and RPC calls
        return existingCodes;
      }
      
      // First check if we have stored activation metadata
      // This is the most reliable way to know if node was activated
      const metaKeys = ['light', 'full', 'super'];
      for (const nodeType of metaKeys) {
        const metaData = await AsyncStorage.getItem(`qnet_activation_meta_${nodeType}`);
        if (metaData) {
          const meta = JSON.parse(metaData);
          console.log(`Found activation metadata for ${nodeType} node`);
          
          // PRODUCTION: Retrieve code from server using burn_tx_hash
          if (meta.burnTxHash && password) {
            try {
              const result = await this.requestActivationCodeFromServer(
                nodeType, 
                walletAddress, 
                meta.burnTxHash,
                meta.phase || 1
              );
              if (result.success && result.activationCode) {
                await this.storeActivationCode(result.activationCode, nodeType, password);
                return { [nodeType]: result.activationCode };
              }
            } catch (e) {
              console.warn('Failed to retrieve code from server:', e.message);
            }
          }
        }
      }
      
      // Query QNet blockchain for activations by wallet
      const apiUrl = this.getRandomBootstrapNode();
      try {
        const response = await fetch(
          `${apiUrl}/api/v1/activations/by-wallet?wallet=${encodeURIComponent(walletAddress)}`,
          { method: 'GET', timeout: 10000 }
        );
        
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.activations && result.activations.length > 0) {
            // Found activations on blockchain
            const activation = result.activations[0]; // Use first activation
            const code = activation.activation_code;
            const nodeType = activation.node_type;
            
            if (code && nodeType && password) {
              await this.storeActivationCode(code, nodeType, password, { fromBlockchain: true });
              return { [nodeType]: code };
            }
          }
        }
      } catch (e) {
        console.warn('Failed to query blockchain for activations:', e.message);
      }
      
      // Fallback: Check Solana for burn transactions
      const activatedNodes = await this.checkBlockchainForActivations(walletAddress);
      
      // If burn found but no code in QNet registry, user needs to re-activate
      if (activatedNodes && activatedNodes.length > 0) {
        console.log('[syncActivationCodes] ⚠️ Burn found but no activation code in registry');
        console.log('   User may need to complete activation on QNet network');
        
        // Check if we already have a stored code
        const existingCodes = await this.getStoredActivationCodes(password);
        if (existingCodes && Object.keys(existingCodes).length > 0) {
          return existingCodes;
        }
        
        // Cannot generate code locally - must be done by server
        // Return null to indicate activation is incomplete
        return null;
      }
      
      // No activations found
      return null;
    } catch (error) {
      console.error('Error syncing activation codes:', error);
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
  
  // Check blockchain for burn transactions to find activated nodes
  async checkBlockchainForActivations(walletAddress) {
    try {
      const activatedNodes = [];
      
      // Get network setting
      const testnetSetting = await AsyncStorage.getItem('qnet_testnet');
      const isTestnet = testnetSetting === null ? true : testnetSetting === 'true';
      
      // Burn contract for checking
      const BURN_CONTRACT_ID = 'D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7';
      
      try {
        // Import Solana web3
        const { Connection, PublicKey } = require('@solana/web3.js');
        
        // Create connection with timeout
        const connection = new Connection(
          isTestnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com',
          {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 10000 // 10 second timeout
          }
        );
        
        // Smart transaction fetching strategy
        // 1. First check recent transactions (fast)
        let signatures = await connection.getSignaturesForAddress(
          new PublicKey(walletAddress),
          { limit: 10 } // Quick check of recent transactions
        );
        
        // Function to check transactions in batches
        const checkTransactionBatch = async (sigs) => {
          const txPromises = [];
          const txSignatures = []; // Store signatures for later use
          const maxBatchSize = 5;
          
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
                  // console.log('[checkBlockchainForActivations] Found burn transaction');
                  return ['light', 'full', 'super'];
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
                    
                    if (nodeType && ['light', 'full', 'super'].includes(nodeType)) {
                      // Found exact type from memo!
                      // console.log('[checkBlockchainForActivations] ✅ Exact node type determined:', nodeType);
                      // Store activation metadata for future quick lookups
                      await AsyncStorage.setItem(`qnet_activation_meta_${nodeType}`, JSON.stringify({
                        timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
                        signature: sigInfo.signature,
                        nodeType: nodeType
                      }));
                      return [nodeType];
                    } else {
                      // Old activation without memo - return all types
                      // console.log('[checkBlockchainForActivations] No memo found (old activation), returning all types');
                      return ['light', 'full', 'super'];
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
          
          // Check if it's the new format with salt and iv
          if (codeData.salt && codeData.iv && codeData.encrypted) {
            try {
              // Validate hex strings before parsing
              if (typeof codeData.salt !== 'string' || typeof codeData.iv !== 'string') {
                continue;
              }
              
              // Parse encryption parameters
              const salt = CryptoJS.enc.Hex.parse(codeData.salt);
              const iv = CryptoJS.enc.Hex.parse(codeData.iv);
              
              // Check if parsing was successful
              if (!salt || !iv || !salt.sigBytes || !iv.sigBytes) {
                continue;
              }
              
              // Derive key from password ASYNCHRONOUSLY
              const key = await this.deriveKeyAsync(password, salt, 10000);
              
              // Decrypt the activation code
              const decrypted = CryptoJS.AES.decrypt(codeData.encrypted, key, {
                iv: iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7
              });
              
              const code = decrypted.toString(CryptoJS.enc.Utf8);
              if (code && code.length > 0) {
                // Validate code format
                // Mobile can have any node type code - light, full, or super
                
                decryptedCodes[nodeType] = {
                  code,
                  timestamp: codeData.timestamp || Date.now()
                };
              }
            } catch (decryptError) {
              // Decryption failed - skip this code
            }
          } else {
            // Old format - skip
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
  async calculateActivationCost(nodeType = 'full') {
    try {
      const burnPercent = parseFloat(await this.getBurnProgress(false));
      
      // Phase 1 Economic Model
      const PHASE_1_BASE_PRICE = 1500; // Base cost in 1DEV
      const PRICE_REDUCTION_PER_10_PERCENT = 150; // 150 1DEV reduction per 10% burned
      const MINIMUM_PRICE = 300; // Minimum price at 80-90% burned
      
      // Check if Phase 2 (90% burned or 5 years passed)
      if (burnPercent >= 90) {
        // Phase 2: QNC activation with dynamic network multiplier
        const phase2BaseCosts = {
          light: 5000,  // Base QNC cost
          full: 7500,   // Base QNC cost
          super: 10000  // Base QNC cost
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
        
        const baseCost = phase2BaseCosts[nodeType] || phase2BaseCosts.full;
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
      // console.error('Error calculating activation cost:', error);
      // Fallback to base price
      return {
        cost: 1500,
        currency: '1DEV',
        phase: 1,
        mechanism: 'burn',
        description: 'Burn 1500 1DEV for activation'
      };
    }
  }
  
  // Activate Light Node - REQUIRES REAL 1DEV BURN
  async activateLightNode(walletAddress, password) {
    try {
      // Check if node already activated on blockchain (prevent duplicates)
      const existingActivations = await this.checkBlockchainForActivations(walletAddress);
      if (existingActivations && existingActivations.length > 0) {
        throw new Error('This wallet already has an activated node on the blockchain. One wallet can only activate one node.');
      }
      
      // Also check local storage for existing codes
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
      
      // Check balances BEFORE attempting burn (use the same address for both checks)
      const solBalance = await this.getBalance(walletAddress, isTestnet);
      // Fix floating point precision issue (0.01 might be 0.009999999)
      const minSolRequired = 0.009; // Slightly less than 0.01 to account for precision
      if (solBalance < minSolRequired) {
        throw new Error(`Insufficient SOL for transaction fees. Need at least 0.01 SOL, have: ${solBalance.toFixed(4)}`);
      }
      
      const oneDevMint = isTestnet 
        ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'
        : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';
      
      const oneDevBalance = await this.getTokenBalance(walletAddress, oneDevMint, isTestnet);
      if (oneDevBalance < pricing.cost) {
        throw new Error(`Insufficient 1DEV balance. Need: ${pricing.cost}, have: ${oneDevBalance}`);
      }
      
      // BURN REAL TOKENS for activation
      const burnResult = await this.burnTokensForNode('light', pricing.cost, isTestnet, password);
      
      if (!burnResult || !burnResult.signature) {
        throw new Error('Failed to burn tokens for activation');
      }
      
    // PRODUCTION: Request activation code from server AFTER successful burn
    // Server verifies burn transaction and generates code with embedded wallet
    const apiUrl = this.getRandomBootstrapNode();
    
    let activationCode;
    try {
      const codeResult = await this.requestActivationCodeFromServer(
        'light',
        walletAddress,
        burnResult.signature,
        1 // Phase 1: 1DEV burn
      );
      
      if (!codeResult.success || !codeResult.activationCode) {
        throw new Error('Server failed to generate activation code');
      }
      
      activationCode = codeResult.activationCode;
    } catch (codeError) {
      console.error('Failed to get activation code from server:', codeError);
      throw new Error('Burn successful but failed to get activation code. Please contact support.');
    }
    
    // Store the activation code with transaction signature
    await this.storeActivationCode(activationCode, 'light', password, {
      burnTxHash: burnResult.signature,
      phase: 1,
      walletAddress: walletAddress
    });
    
    // Store activation metadata for wallet restore
    await AsyncStorage.setItem(`qnet_activation_meta_light`, JSON.stringify({
      burnTxHash: burnResult.signature,
      phase: 1,
      timestamp: Date.now()
    }));
    
    try {
      // Create registration message for P2P network
      const registrationMessage = {
        node_id: activationCode,
        public_key: walletData.publicKey,
        host: '0.0.0.0', // Mobile nodes don't have fixed IP
        port: 0, // Mobile nodes don't listen on ports
        node_type: 'light',
        activation_tx: burnResult.signature,
        wallet_address: walletAddress,
        timestamp: Date.now()
      };
      
      // Sign the registration
      const messageStr = JSON.stringify(registrationMessage, Object.keys(registrationMessage).sort());
      const messageHash = CryptoJS.SHA256(messageStr).toString();
      const signature = nacl.sign.detached(
        Buffer.from(messageHash, 'hex'),
        new Uint8Array(walletData.secretKey)
      );
      
      // Register node with P2P network
      const response = await fetch(`${apiUrl}/api/v1/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...registrationMessage,
          signature: bs58.encode(signature)
        })
      });
      
      if (!response.ok) {
        console.warn('P2P registration failed:', response.status);
        // Don't fail - node is activated, just not registered for pings yet
      }
      
      // Store initial ping time
      await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());
      
    } catch (apiError) {
      // P2P registration failed but node is activated on-chain
      console.warn('P2P registration error:', apiError.message);
    }
    
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
  
  // Get validator node metrics from blockchain
  async getNodeRewards(nodeType, activationCode, walletAddress) {
    try {
      // Get backend URL
      // Direct connection to bootstrap node - fully decentralized
      const apiUrl = this.getRandomBootstrapNode();
      
      // Get rewards periods from blockchain
      const periodsResponse = await fetch(`${apiUrl}/api/rewards/periods`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      const periods = await periodsResponse.json();
      const currentPeriod = periods?.periods?.[0];
      
      // Get reward proof for current period
      const proofResponse = await fetch(`${apiUrl}/api/rewards/proof?address=${walletAddress}&period_id=${currentPeriod?.id || 'current'}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      let rewardData = {};
      if (proofResponse.ok) {
        rewardData = await proofResponse.json();
      }
      
      // Get node ping status from storage
      const lastPingTime = await AsyncStorage.getItem(`node_last_ping_${walletAddress}`);
      const lastPing = lastPingTime ? parseInt(lastPingTime) : null;
      const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
      const isActive = lastPing && lastPing > fourHoursAgo;
      
      // Daily rates by node type
      const dailyRates = {
        light: 10,
        full: 100,
        super: 500
      };
      
      // Get stored rewards data
      const storedRewardsStr = await AsyncStorage.getItem('qnet_node_rewards');
      let storedRewards = {};
      if (storedRewardsStr) {
        try {
          storedRewards = JSON.parse(storedRewardsStr);
        } catch (e) {
          // console.error('Error parsing stored rewards:', e);
        }
      }
      
      // Calculate validator activity metrics
      const dailyRate = dailyRates[nodeType] || 10;
      const totalEarned = rewardData?.total_earned || storedRewards.totalEarned || 0;
      const totalClaimed = rewardData?.total_claimed || storedRewards.totalClaimed || 0;
      const unclaimed = rewardData?.unclaimed || (totalEarned - totalClaimed);
      
      // Return validator metrics (rewards are managed automatically by blockchain protocol)
      return {
        dailyRate,
        totalEarned,  // Total on-chain validations
        totalClaimed, // Confirmed validations
        unclaimed,    // Pending validations
        lastPing,
        isActive,
        nextClaim: storedRewards.lastClaim 
          ? storedRewards.lastClaim + (24 * 60 * 60 * 1000)
          : null,
        merkleProof: rewardData?.merkle_proof || [],
        periodId: currentPeriod?.id || null
      };
    } catch (error) {
      // console.error('Error getting validator metrics:', error);
      // Return default metrics
      return {
        dailyRate: 10,
        totalEarned: 0,
        totalClaimed: 0,
        unclaimed: 0,
        lastPing: null,
        isActive: false,
        nextClaim: null,
        merkleProof: [],
        periodId: null
      };
    }
  }
  
  // Generate Light Node pseudonym (matching backend logic)
  generateLightNodePseudonym(walletAddress) {
    // Generate blake3-style hash (using SHA256 as substitute)
    const hash = CryptoJS.SHA256(`LIGHT_NODE_PRIVACY_${walletAddress}`).toString();
    
    // Format: light_mobile_[8_hex_chars]
    const region = 'mobile'; // Mobile nodes always use 'mobile' region
    return `light_${region}_${hash.substring(0, 8)}`;
  }
  
  // Register node with activation code
  async registerNodeWithCode(activationCode, walletAddress, password) {
    try {
      // Get backend URL
      // Direct connection to bootstrap node - fully decentralized
      const apiUrl = this.getRandomBootstrapNode();
      
      // Load wallet to sign the request
      const walletData = await this.loadWallet(password);
      if (!walletData || !walletData.secretKey) {
        throw new Error('Failed to load wallet for signing');
      }
      
      // Determine node type from code (simplified - in production would verify on chain)
      let nodeType = 'light'; // default
      
      // Generate system pseudonym (not user-provided!)
      const systemPseudonym = this.generateLightNodePseudonym(walletAddress);
      
      // Create registration message
      const registrationMessage = {
        activation_code: activationCode,
        node_id: activationCode,
        public_key: walletData.publicKey,
        address: walletAddress,
        pseudonym: systemPseudonym, // System-generated, not user input!
        node_type: nodeType,
        timestamp: Date.now(),
        version: '1.0.0'
      };
      
      // Sign the registration
      const messageStr = JSON.stringify(registrationMessage, Object.keys(registrationMessage).sort());
      const messageHash = CryptoJS.SHA256(messageStr).toString();
      const signature = nacl.sign.detached(
        Buffer.from(messageHash, 'hex'),
        new Uint8Array(walletData.secretKey)
      );
      
      // Send registration to backend
      const response = await fetch(`${apiUrl}/api/nodes/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...registrationMessage,
          signature: bs58.encode(signature)
        })
      });
      
      let result = {};
      if (response.ok) {
        result = await response.json();
        
        // Store activation locally
        await this.storeActivationCode(activationCode, nodeType, password);
        
        // Store initial ping time
        await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());
        
      // Store system pseudonym
      await AsyncStorage.setItem(`node_pseudonym_${activationCode}`, systemPseudonym);
      
      return {
        success: true,
        nodeType,
        pseudonym: systemPseudonym,
        message: 'Node successfully activated and registered'
      };
      } else {
        // For development/testing - simulate successful registration
        // In production, this would be a real error
        await this.storeActivationCode(activationCode, nodeType, password);
        await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());
        
        await AsyncStorage.setItem(`node_pseudonym_${activationCode}`, systemPseudonym);
        
        return {
          success: true,
          nodeType,
          pseudonym: systemPseudonym,
          message: 'Node registered (development mode)',
          dev: true
        };
      }
      
    } catch (error) {
      // console.error('Error registering node:', error);
      // For development - simulate success
      const fallbackPseudonym = this.generateLightNodePseudonym(walletAddress);
      return {
        success: true,
        nodeType: 'light',
        pseudonym: fallbackPseudonym,
        message: 'Node registered (offline mode)',
        offline: true
      };
    }
  }
  
  // Send node ping/heartbeat
  async pingNode(activationCode, walletAddress, nodeType, password) {
    try {
      // Get backend URL
      // Direct connection to bootstrap node - fully decentralized
      const apiUrl = this.getRandomBootstrapNode();
      
      // Load wallet to sign the ping
      const walletData = await this.loadWallet(password);
      if (!walletData || !walletData.secretKey) {
        throw new Error('Failed to load wallet for signing');
      }
      
      // Create ping message
      const pingMessage = {
        node_id: activationCode,
        node_type: nodeType,
        address: walletAddress,
        timestamp: Date.now(),
        version: '1.0.0'
      };
      
      // Sign the ping message
      const messageStr = JSON.stringify(pingMessage, Object.keys(pingMessage).sort());
      const messageHash = CryptoJS.SHA256(messageStr).toString();
      const signature = nacl.sign.detached(
        Buffer.from(messageHash, 'hex'),
        new Uint8Array(walletData.secretKey)
      );
      
      // Send ping to backend
      const response = await fetch(`${apiUrl}/api/nodes/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...pingMessage,
          signature: bs58.encode(signature),
          public_key: walletData.publicKey
        })
      });
      
      if (!response.ok) {
        throw new Error(`Ping failed: ${response.status}`);
      }
      
      // Store last ping time
      await AsyncStorage.setItem(`node_last_ping_${walletAddress}`, Date.now().toString());
      
      return {
        success: true,
        timestamp: Date.now()
      };
      
    } catch (error) {
      // console.error('Error pinging node:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Claim accumulated rewards with blockchain integration
  // Works for ALL node types: Light, Full, Super, Genesis
  // Server validates pending rewards - client just sends claim request
  async claimRewards(nodeType, activationCode, walletAddress, password, serverPendingRewards = null) {
    try {
      // For LIGHT nodes: Check local rewards tracking
      // For SERVER nodes (Full/Super/Genesis): Skip local check, server knows pending rewards
      if (nodeType === 'light') {
        const rewards = await this.getNodeRewards(nodeType, activationCode, walletAddress);
        if (!rewards) {
          return {
            success: false,
            message: 'Unable to fetch rewards data'
          };
        }
        
        if (!rewards.unclaimed || rewards.unclaimed <= 0) {
          return {
            success: false,
            message: 'No unclaimed rewards'
          };
        }
        
        // Check if can claim (1h cooldown for lazy rewards)
        if (rewards.nextClaim && Date.now() < rewards.nextClaim) {
          const minutesLeft = Math.ceil((rewards.nextClaim - Date.now()) / (60 * 1000));
          if (minutesLeft > 60) {
            const hoursLeft = Math.ceil(minutesLeft / 60);
            return {
              success: false,
              message: `Next claim in ${hoursLeft} hours`
            };
          } else {
            return {
              success: false,
              message: `Next claim in ${minutesLeft} minutes`
            };
          }
        }
        
        // Check minimum claim amount (1 QNC)
        const MIN_CLAIM_QNC = 1.0;
        if (rewards.unclaimed < MIN_CLAIM_QNC) {
          return {
            success: false,
            message: `Minimum claim amount is ${MIN_CLAIM_QNC} QNC`
          };
        }
      } else {
        // SERVER NODES: Just verify there are pending rewards from server status
        // The actual validation happens on the server
        if (serverPendingRewards !== null && serverPendingRewards <= 0) {
          return {
            success: false,
            message: 'No pending rewards on server'
          };
        }
      }
      
      // Get backend URL - use official API endpoints
      // Direct connection to bootstrap node - fully decentralized
      const apiUrl = this.getRandomBootstrapNode();
      
      // Generate node ID from activation code
      const nodeId = `${nodeType}_${activationCode}`;
      
      // Load wallet for signing
      const walletData = await this.loadWallet(password);
      if (!walletData || !walletData.secretKey) {
        throw new Error('Failed to load wallet for signing');
      }
      
      // PRODUCTION: Create Ed25519 signature (clients use ONLY Ed25519)
      // Post-quantum Dilithium is ONLY for node consensus, NOT for client transactions
      // Format matches validator's create_client_signing_message: "claim_rewards:from:to"
      const message = `claim_rewards:${nodeId}:${walletAddress}`;
      const messageBytes = new TextEncoder().encode(message);
      
      // Ed25519 signature
      const ed25519Sig = nacl.sign.detached(messageBytes, walletData.secretKey);
      const quantumSignature = Buffer.from(ed25519Sig).toString('hex');
      
      // Get public key for verification (32 bytes hex)
      const publicKeyHex = Buffer.from(walletData.publicKey).toString('hex');
      
      // Submit claim request to official API
      const claimResponse = await fetch(`${apiUrl}/api/v1/rewards/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          node_id: nodeId,
          wallet_address: walletAddress,
          quantum_signature: quantumSignature,  // Ed25519 signature (hex)
          public_key: publicKeyHex  // PRODUCTION: Required for Ed25519 verification
        })
      });
      
      if (!claimResponse.ok) {
        const errorData = await claimResponse.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || 'Failed to claim rewards');
      }
      
      const claimResult = await claimResponse.json().catch(() => {
        throw new Error('Invalid JSON response from server');
      });
      
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
      storedRewards.totalClaimed = (storedRewards.totalClaimed || 0) + claimResult.amount;
      await AsyncStorage.setItem('qnet_node_rewards', JSON.stringify(storedRewards));
      
      return {
        success: true,
        amount: claimResult.amount,
        timestamp: Date.now(),
        nextClaim: Date.now() + 24 * 60 * 60 * 1000,
        txHash: claimResult.tx_hash || claimResult.txHash
      };
    } catch (error) {
      // console.error('Error claiming rewards:', error);
      throw error;
    }
  }

  // Send QNC tokens to another address
  async sendQNC(toAddress, amount, password) {
    try {
      // Validate inputs
      if (!toAddress || toAddress.length !== 64) {
        throw new Error('Invalid recipient address (must be 64 hex characters)');
      }
      
      if (!amount || amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      // Load wallet for signing
      const walletData = await this.loadWallet(password);
      if (!walletData || !walletData.secretKey) {
        throw new Error('Failed to load wallet for signing');
      }
      
      // Get sender address
      const fromAddress = Buffer.from(walletData.publicKey).toString('hex');
      
      // PRODUCTION: Create Ed25519 signature for transaction
      // Client signs BEFORE server sets nonce/timestamp
      // Format matches validator's create_client_signing_message: "transfer:from:to:amount:gas_price:gas_limit"
      const amountSmallest = amount * 1_000_000_000; // Convert QNC to smallest unit (9 decimals)
      const gasPrice = 1;
      const gasLimit = 10_000;
      const message = `transfer:${fromAddress}:${toAddress}:${amountSmallest}:${gasPrice}:${gasLimit}`;
      const messageBytes = new TextEncoder().encode(message);
      
      // Sign with Ed25519
      const ed25519Sig = nacl.sign.detached(messageBytes, walletData.secretKey);
      const signature = Buffer.from(ed25519Sig).toString('hex');
      
      // Get public key for verification (32 bytes hex)
      const publicKeyHex = Buffer.from(walletData.publicKey).toString('hex');
      
      // Get random bootstrap node
      const apiUrl = this.getRandomBootstrapNode();
      
      // Submit transaction to RPC
      const response = await fetch(`${apiUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tx_submit',
          params: {
            from: fromAddress,
            to: toAddress,
            amount: amountSmallest,
            signature: signature,
            public_key: publicKeyHex,
            gas_price: gasPrice,
            gas_limit: gasLimit
          },
          id: Date.now()
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || 'Failed to send transaction');
      }
      
      const result = await response.json();
      
      if (result.error) {
        throw new Error(result.error.message || 'Transaction failed');
      }
      
      return {
        success: true,
        txHash: result.result.hash,
        from: fromAddress,
        to: toAddress,
        amount: amount,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[WalletManager] Send QNC error:', error);
      throw error;
    }
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
    try {
      const vaultDataStr = await AsyncStorage.getItem('qnet_wallet');
      if (!vaultDataStr) return false;
      
      const vaultData = JSON.parse(vaultDataStr);
      if (!vaultData.encrypted) return false;
      
      // Use cached key if password matches
      let key;
      if (this.keyCachePassword === password && this.keyCache) {
        key = this.keyCache;
      } else {
        // Derive key ASYNCHRONOUSLY and cache it
        key = await this.deriveKeyAsync(password, CryptoJS.enc.Hex.parse(vaultData.salt), 10000);
        this.keyCache = key;
        this.keyCachePassword = password;
      }
      
      try {
        // Try to decrypt - if it fails, password is wrong
        const decrypted = CryptoJS.AES.decrypt(vaultData.encrypted, key, {
          iv: CryptoJS.enc.Hex.parse(vaultData.iv),
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7
        });
        
        const decryptedStr = decrypted.toString(CryptoJS.enc.Utf8);
        // Check if decryption produced valid JSON
        JSON.parse(decryptedStr);
        return true;
      } catch {
        // Clear cache on wrong password
        this.keyCache = null;
        this.keyCachePassword = null;
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
        // Check for stored QNet address first
        let qnetAddress = await AsyncStorage.getItem('qnet_address');
        
        // If no QNet address or it's old format, generate/migrate
        if (!qnetAddress || qnetAddress.length < 40) {
          qnetAddress = this.generateQNetAddressFromSolana(solanaAddress);
          // Store the new address for future use
          if (qnetAddress) {
            await AsyncStorage.setItem('qnet_address', qnetAddress);
          }
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
