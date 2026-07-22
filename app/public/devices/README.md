# Product photos

Drop the keypad product photos here — the app references them by these exact
names (see `MODEL_META` in `src/lib/types.ts`):

- `core6.png` — MKYADA Core 6
- `vision6.png` — MKYADA Vision 6

Square-ish PNGs with a transparent background look best; they are shown at
small sizes (device cards, setup wizard). Until a photo exists, the
`ProductImage` component falls back to the MKYADA logo + model label, so
missing files are harmless.
