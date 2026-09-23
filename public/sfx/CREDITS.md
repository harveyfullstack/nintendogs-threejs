# Sound credits

Every file in this folder is a short excerpt of a public-domain or CC0 recording from
Wikimedia Commons. Licences were checked on each file's description page (September 2026).
Processing: trimmed, fades added, high-/low-passed, spectrally denoised (puppy clips only,
ffmpeg `afftdn`), peak-normalised to -1 dBFS and encoded as mono MP3. At runtime
`src/game/audio.ts` pitch-shifts, filters and randomises them per dog voice.

Everything else in the game (the other dog sounds, all UI/world SFX, the loops and all
music) is synthesised in code.

| Files | Source | Author | Licence | Excerpt |
| --- | --- | --- | --- | --- |
| `bark1.mp3`, `bark2.mp3`, `bark3.mp3` | [File:Ladrido perro.ogg](https://commons.wikimedia.org/wiki/File:Ladrido_perro.ogg) | Edo.pt2 | CC0 1.0 | the three barks at 1.09 s, 1.74 s and 2.82 s |
| `whine1.mp3`, `whine2.mp3`, `whine3.mp3` | [File:Viltspar hund med skank.oga](https://commons.wikimedia.org/wiki/File:Viltspar_hund_med_skank.oga) (Basset Hound after tracking) | Cali1008 | Public domain (PD-self) | whines at 2.86–3.96 s |
| `pup1.mp3` … `pup5.mp3` | [File:Puppy at a night.ogg](https://commons.wikimedia.org/wiki/File:Puppy_at_a_night.ogg) ("A crying normal puppy") | Knites | CC0 1.0 | cries at 22.2–23.0 s and 25.7–27.6 s |
