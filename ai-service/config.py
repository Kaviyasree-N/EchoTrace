"""
ai-service/config.py – Configuration for EchoTrace YAMNet AI Service
"""

PORT = 5000
HOST = "0.0.0.0"

SAMPLE_RATE = 16000          # YAMNet standard 16kHz mono audio
CHUNK_DURATION = 1.0         # seconds per classification window
CONFIDENCE_THRESHOLD = 0.40  # Minimum confidence to accept a detection

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

YAMNET_MODEL_URL = "https://tfhub.dev/google/yamnet/1"
YAMNET_CLASS_MAP_URL = (
    "https://raw.githubusercontent.com/tensorflow/models/master/"
    "research/audioset/yamnet/yamnet_class_map.csv"
)
