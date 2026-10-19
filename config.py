# EchoTrace Configuration
# ========================
# Core audio settings
SAMPLE_RATE = 16000          # YAMNet expects 16kHz mono audio
CHUNK_DURATION = 1           # seconds per analysis chunk
CONFIDENCE_THRESHOLD = 0.4   # Minimum confidence to log an event

# Target sound classes to watch for (subset of AudioSet labels)
# These are common household sounds relevant to dementia caregiving context
TARGET_CLASSES = [
    # Door / access sounds
    "Door",
    "Doorbell",
    "Knock",
    "Sliding door",
    "Cupboard",
    "Drawer",
    "Keys jingling",

    # Kitchen / household
    "Frying (food)",
    "Water tap, faucet",
    "Dishes, pots, and pans",
    "Microwave oven",
    "Blender",
    "Coffee maker",
    "Stove",

    # Movement & activity
    "Footsteps",
    "Chair",
    "Squeak",
    "Zipper (clothing)",

    # Alert / safety sounds
    "Smoke detector, smoke alarm",
    "Fire alarm",
    "Alarm clock",
    "Telephone",
    "Cell phone",
    "Ringtone",

    # TV / media
    "Television",
    "Radio",

    # Human activity
    "Cough",
    "Sneeze",
    "Snoring",
    "Crying, sobbing",
    "Laughter",
    "Speech",
    "Conversation",

    # Appliances
    "Vacuum cleaner",
    "Washing machine",
    "Toilet flush",
    "Shower",
    "Bathtub (filling or washing)",
]

# SQLite database file
DB_PATH = "echotrace.db"

# YAMNet model URL on TensorFlow Hub
YAMNET_MODEL_URL = "https://tfhub.dev/google/yamnet/1"

# YAMNet class map CSV (AudioSet ontology)
YAMNET_CLASS_MAP_URL = (
    "https://raw.githubusercontent.com/tensorflow/models/master/"
    "research/audioset/yamnet/yamnet_class_map.csv"
)
