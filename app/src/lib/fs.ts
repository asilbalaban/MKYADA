import { invoke } from "@tauri-apps/api/core";

/** Read a file the user picked via the open-file dialog. */
export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_local_file", { path });
}
