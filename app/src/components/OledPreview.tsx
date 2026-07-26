// A little Vision 6 OLED: 128×64 drawn with the device's OWN font and layout
// (lib/oled-draw runs the firmware's drawing code over firmware/fonts/
// mkyada.fnt), then upscaled with image-rendering: pixelated inside a bezel.
// It isn't an impression of the screen — it's the picture the screen shows when
// you press the wheel on this key (see kind-registry.wheelPreview).

import { useEffect, useRef } from "react";
import { OLED_H, OLED_W, drawWheelScreen, type WheelPreview } from "../lib/oled-draw";

export function OledPreview({ preview, scale = 2 }: { preview: WheelPreview; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (c) drawWheelScreen(c, preview);
  }, [preview]);

  // `scale` is a CEILING, not a fixed size: the bezel takes the width it is
  // given and stops growing there. A fixed pixel width broke both ways inside
  // a flex/grid column — it overflowed a narrow one, and in a wide one the
  // bezel stretched to the column while the picture inside stayed put.
  return (
    <div
      className="w-full rounded-lg p-2"
      style={{
        maxWidth: OLED_W * scale + 16, // + the 8px padding on each side
        background: "linear-gradient(#20242c, #171a20)",
        border: "1px solid #2c313b",
      }}
    >
      <canvas
        ref={ref}
        width={OLED_W}
        height={OLED_H}
        style={{
          display: "block",
          width: "100%",
          height: "auto",
          aspectRatio: `${OLED_W} / ${OLED_H}`,
          imageRendering: "pixelated",
          borderRadius: 4,
          background: "#000",
        }}
      />
    </div>
  );
}
