export const ROOMS = [
  'Living Room',
  'Kitchen',
  'Bedroom',
  'Bathroom',
  'Hallway',
  'Garden',
  'Dining Room',
  'Office',
] as const;

export const TARGET_CLASSES = [
  // Door / access sounds
  'Door',
  'Doorbell',
  'Knock',
  'Sliding door',
  'Cupboard',
  'Drawer',
  'Keys jingling',

  // Kitchen / household
  'Frying (food)',
  'Water tap, faucet',
  'Dishes, pots, and pans',
  'Microwave oven',
  'Blender',
  'Coffee maker',
  'Stove',

  // Movement & activity
  'Footsteps',
  'Chair',
  'Squeak',
  'Zipper (clothing)',

  // Alert / safety sounds
  'Smoke detector, smoke alarm',
  'Fire alarm',
  'Alarm clock',
  'Telephone',
  'Cell phone',
  'Ringtone',

  // TV / media
  'Television',
  'Radio',

  // Human activity
  'Cough',
  'Sneeze',
  'Snoring',
  'Crying, sobbing',
  'Laughter',
  'Speech',
  'Conversation',

  // Appliances
  'Vacuum cleaner',
  'Washing machine',
  'Toilet flush',
  'Shower',
  'Bathtub (filling or washing)',
] as const;

export const SAMPLE_RATE = 16000;
export const CONFIDENCE_THRESHOLD = 0.4;
