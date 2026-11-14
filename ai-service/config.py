"""
ai-service/config.py – Configuration for EchoTrace YAMNet AI Service
"""

PORT = 5000
HOST = "0.0.0.0"

SAMPLE_RATE = 16000          # YAMNet standard 16kHz mono audio
CHUNK_DURATION = 1.0         # seconds per classification window
CONFIDENCE_THRESHOLD = 0.40  # Default minimum confidence to accept a detection

# Target AudioSet / YAMNet sound classes relevant to dementia caregiving
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

    # Appliances & facilities
    "Vacuum cleaner",
    "Washing machine",
    "Toilet flush",
    "Shower",
    "Bathtub (filling or washing)",

    # Emergency / impacts
    "Glass breaking",
    "Loud impacts",
]

# Explicit AudioSet (yamnet_class_map.csv) -> EchoTrace canonical target class mapping.
# Keys are matched case-insensitively against exact AudioSet display_name entries.
AUDIOSET_TO_TARGET = {
    # Door / access
    "Door": "Door",
    "Doorbell": "Doorbell",
    "Ding-dong": "Doorbell",
    "Knock": "Knock",
    "Tap": "Knock",
    "Sliding door": "Sliding door",
    "Cupboard open or close": "Cupboard",
    "Drawer open or close": "Drawer",
    "Keys jangling": "Keys jingling",

    # Kitchen / household
    "Frying (food)": "Frying (food)",
    "Sizzle": "Frying (food)",
    "Water tap, faucet": "Water tap, faucet",
    "Sink (filling or washing)": "Water tap, faucet",
    "Dishes, pots, and pans": "Dishes, pots, and pans",
    "Cutlery, silverware": "Dishes, pots, and pans",
    "Microwave oven": "Microwave oven",
    "Blender": "Blender",

    # Movement & activity
    "Walk, footsteps": "Footsteps",
    "Run": "Footsteps",
    "Shuffle": "Footsteps",
    "Squeak": "Squeak",
    "Zipper (clothing)": "Zipper (clothing)",

    # Critical / Safety & Emergency
    "Smoke detector, smoke alarm": "Smoke detector, smoke alarm",
    "Fire alarm": "Fire alarm",
    "Alarm clock": "Alarm clock",
    "Telephone": "Telephone",
    "Telephone bell ringing": "Telephone",
    "Ringtone": "Ringtone",
    "Glass": "Glass breaking",
    "Shatter": "Glass breaking",
    "Breaking": "Glass breaking",
    "Thump, thud": "Loud impacts",
    "Smash, crash": "Loud impacts",

    # TV / media
    "Television": "Television",
    "Radio": "Radio",

    # Human vocalizations & speech
    "Cough": "Cough",
    "Throat clearing": "Cough",
    "Sneeze": "Sneeze",
    "Snoring": "Snoring",
    "Crying, sobbing": "Crying, sobbing",
    "Baby cry, infant cry": "Crying, sobbing",
    "Whimper": "Crying, sobbing",
    "Laughter": "Laughter",
    "Giggle": "Laughter",
    "Chuckle, chortle": "Laughter",
    "Speech": "Speech",
    "Child speech, kid speaking": "Speech",
    "Narration, monologue": "Speech",
    "Whispering": "Speech",
    "Hubbub, speech noise, speech babble": "Speech",
    "Conversation": "Conversation",

    # Appliances & facilities
    "Vacuum cleaner": "Vacuum cleaner",
    "Toilet flush": "Toilet flush",
    "Shower": "Shower",
    "Bathtub (filling or washing)": "Bathtub (filling or washing)",
}

# Sound category groupings
CRITICAL_CLASSES = {
    "Smoke detector, smoke alarm",
    "Fire alarm",
    "Glass breaking",
    "Loud impacts",
    "Crying, sobbing",
}

SPEECH_CLASSES = {
    "Speech",
    "Conversation",
}

# Category-specific confidence thresholds (when base threshold is at default 0.40)
CATEGORY_THRESHOLDS = {
    "critical": 0.30,    # High sensitivity for smoke, fire, glass break
    "impact": 0.48,      # Prevent mic bumps from triggering Loud impacts
    "speech": 0.34,      # Responsive speech detection
    "footsteps": 0.58,   # Stricter threshold to eliminate speech->footstep false positives
    "default": CONFIDENCE_THRESHOLD,
}

# Map specific canonical classes to threshold categories
CLASS_TO_CATEGORY = {
    "Smoke detector, smoke alarm": "critical",
    "Fire alarm": "critical",
    "Glass breaking": "critical",
    "Crying, sobbing": "critical",
    "Loud impacts": "impact",
    "Speech": "speech",
    "Conversation": "speech",
    "Footsteps": "footsteps",
}

# Temporal smoothing & anti-false-positive parameters
TEMPORAL_SMOOTHING_WINDOW = 4
TEMPORAL_EMA_ALPHA = 0.55
TEMPORAL_SESSION_TTL_SEC = 8.0
FOOTSTEPS_CONFIRMATION_CHUNKS = 2
FOOTSTEPS_HIGH_CONF_BYPASS = 0.90

# Voice Activity Detection (VAD) thresholds
VAD_SILENCE_RMS = 0.015
VAD_SPEECH_ACTIVE_THRESHOLD = 0.52

YAMNET_MODEL_URL = "https://tfhub.dev/google/yamnet/1"
YAMNET_CLASS_MAP_URL = (
    "https://raw.githubusercontent.com/tensorflow/models/master/"
    "research/audioset/yamnet/yamnet_class_map.csv"
)
