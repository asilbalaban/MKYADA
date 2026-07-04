# 3D-printed case

The MKYADA case is a remix of the wonderful **Stream Cheap** design — we did
not draw these models, we stand on the shoulders of the makers credited below.

## Files in this folder

| File | What it is | Source |
|---|---|---|
| `Stream Cheap RP2040.stl` | Case body (3×2), USB-C cutout for the RP2040-Zero | [Stream Cheap 3x2 RP2040 Zero](https://www.printables.com/model/989881-stream-cheap-3x2-rp2040-zero) by **schichtbude** |
| `FacePlate_3x2.stl` | 3×2 face plate (cover) | [Stream Cheap (3x2, 4x2, 5x2) Remixed](https://www.thingiverse.com/thing:4497991) by **hartk1213** (CC BY 4.0) |

## Credits

1. **[Stream Cheap (Mini Macro Keyboard)](https://www.printables.com/model/157035-stream-cheap-mini-macro-keyboard)** by **dmadison** —
   the original design this whole family of cases comes from.
2. **[Stream Cheap 3x2 RP2040 Zero](https://www.printables.com/model/989881-stream-cheap-3x2-rp2040-zero)** by **schichtbude** —
   the fork we actually print: the body is adapted to the RP2040-Zero board
   MKYADA uses.
3. **[Stream Cheap (3x2, 4x2, 5x2) Remixed with reset button](https://www.thingiverse.com/thing:4497991)** by **hartk1213** (CC BY 4.0) —
   we use the **3×2 face plate** from this remix.

License terms for the Printables models are on their linked pages; the STLs
are redistributed here with attribution to make building a MKYADA one-stop.

## Print notes (from our build)

- **The face plate is a bit thin as published — scale its Z (thickness) up by
  20% in your slicer** before generating G-code. We printed it as-is first and
  recommend the thicker version.
- Body prints fine with stock settings (0.2 mm layers, no supports needed for
  the 3×2 body when printed open-side up).
- Switches: Cherry MX-compatible, friction-fit into the face plate.
- Wiring goes through the body to the RP2040-Zero — see
  [../wiring.md](../wiring.md).
