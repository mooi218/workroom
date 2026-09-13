# Optional local recordings

Workroom's public distribution uses sound effects generated with browser audio. The following recordings can be imported from a folder on your computer using `npm run import:sounds -- "your-folder"`. Keep the original filenames below. The import copies them into your local `.workroom/sounds` directory; it does not upload them.

| Recording and creator | Filename | Use in Workroom |
| --- | --- | --- |
| [Printer Sound — Alex_Jauk](https://pixabay.com/sound-effects/technology-printer-sound-197880/) | `alex_jauk-printer-sound-197880.mp3` | Printer arrival |
| [Keyboard Typing — DRAGON-STUDIO](https://pixabay.com/sound-effects/film-special-effects-keyboard-typing-sound-effect-335503/) | `dragon-studio-keyboard-typing-sound-effect-335503.mp3` | Seated typing bursts |
| [Coffee machine — sofiamadeira (Freesound), via freesound_community](https://pixabay.com/sound-effects/household-coffee-machine-40834/) | `freesound_community-coffee-machine-40834.mp3` | Coffee machine |
| [Walking in the building — JARASNAT](https://pixabay.com/sound-effects/film-special-effects-walking-in-the-building-sound-227690/) | `jarasnat-walking-in-the-building-sound-227690.mp3` | Soft footstep variation |
| [success — Meldix](https://pixabay.com/sound-effects/film-special-effects-success-340660/) | `meldix-success-340660.mp3` | Newly completed response |
| [IT Office 1 — TheLlywellyn](https://pixabay.com/sound-effects/film-special-effects-it-office-1-535961/) | `thellywellyn-it-office-1-535961.mp3` | Quiet background office ambience |
| [Walking sound effect — u_3x9ga8wevj](https://pixabay.com/sound-effects/film-special-effects-walking-sound-effect-272246/) | `u_3x9ga8wevj-walking-sound-effect-272246.mp3` | Firm footstep variation |

These source pages identify the recordings under the **Pixabay Content License**, not Workroom's MIT code license. Review the [source terms](https://pixabay.com/service/terms/) and [license summary](https://pixabay.com/service/license-summary/) for your intended use. Standalone redistribution is restricted. The recordings are not bundled in Workroom's GitHub repository, hosted demo, or releases.

Playback uses short sections of longer recordings, gentle gain levels, and limits on overlapping sounds. The original imported files are preserved. Completion audio plays for newly observed completed responses, not historical completed tasks on initial load or when sound is enabled. The preview button is an explicit audition.

If a recording is missing or cannot decode, the built-in effect remains available. Sound and leaving the desk start off. Office effects can be silenced while keeping task notifications.
