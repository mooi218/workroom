// Optional local recordings. The public distribution includes synthesized sounds.
// Original recordings are imported into the user's local data directory, never uploaded.
export const SOUND_TRACKS = {
  success: {
    file: "success.mp3",
    source: "meldix-success-340660.mp3",
    gain: 0.9,
    duration: 3.4,
  },
  typing: {
    file: "typing.mp3",
    source: "dragon-studio-keyboard-typing-sound-effect-335503.mp3",
    gain: 0.6,
    duration: 0.7,
    offsets: [0.3, 1.1, 2.1, 4, 5.4],
  },
  coffee: {
    file: "coffee.mp3",
    source: "freesound_community-coffee-machine-40834.mp3",
    gain: 0.18,
    duration: 3.8,
    offsets: [0.4, 1.2],
  },
  printer: {
    file: "printer.mp3",
    source: "alex_jauk-printer-sound-197880.mp3",
    gain: 2.2,
    duration: 3.7,
    offsets: [6.2, 10.2],
  },
  footstepSoft: {
    file: "footsteps-soft.mp3",
    source: "jarasnat-walking-in-the-building-sound-227690.mp3",
    gain: 0.24,
    duration: 0.27,
    offsets: [3.7, 4.9, 5.94, 8.22],
  },
  footstepFirm: {
    file: "footsteps-firm.mp3",
    source: "u_3x9ga8wevj-walking-sound-effect-272246.mp3",
    gain: 0.09,
    duration: 0.25,
    offsets: [0, 0.5, 1, 1.5],
  },
  ambience: {
    file: "office.mp3",
    source: "thellywellyn-it-office-1-535961.mp3",
    gain: 0.3,
    duration: 28.5,
  },
};

export const SOUND_CHOICES = [
  "success",
  "typing",
  "footstep",
  "coffee",
  "printer",
  "ambience",
  "working",
  "waiting",
  "error",
];
