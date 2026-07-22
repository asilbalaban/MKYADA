// Product photo for a keypad model. Photos live in public/devices/ and may
// not be bundled yet — on load error a styled placeholder (MKYADA logo +
// model label) takes the image's place instead of a broken img.

import { useState } from "react";
import { MODEL_META, type DeviceModel } from "../lib/types";

export function ProductImage({
  model,
  className = "",
}: {
  model: DeviceModel;
  className?: string;
}) {
  const [failedModel, setFailedModel] = useState<DeviceModel | null>(null);
  const meta = MODEL_META[model];
  if (failedModel === model) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1 bg-panel2 border border-line rounded-xl p-2 ${className}`}
        role="img"
        aria-label={meta.label}
      >
        <img src="/mkyada-logo.png" alt="" className="w-2/5 max-w-10 min-w-5 rounded-lg" />
        <span className="text-[10px] text-fg-muted text-center leading-tight">{meta.label}</span>
      </div>
    );
  }
  return (
    <img
      src={meta.image}
      alt={meta.label}
      onError={() => setFailedModel(model)}
      className={`object-contain ${className}`}
    />
  );
}
