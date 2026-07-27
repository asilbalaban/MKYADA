// Back up a configured keypad to a file, and put it back — onto the same
// keypad later, or onto a different one of the same model.
//
// The keypad is the only place its own setup lives: config.json plus a
// macros/ directory the app writes one file at a time. Reproducing a finished
// keypad by hand means re-recording every macro, so a single file that
// captures the whole thing is the difference between configuring one keypad
// and configuring twenty.

import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, Upload } from "lucide-react";
import type { Backup } from "../lib/backup";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DEVICE_OWNED_CONFIG,
  backupFileName,
  describeBackup,
  mergeProfiles,
  parseBackup,
} from "../lib/backup";
import { ipc } from "../lib/ipc";
import { useDevice } from "../lib/device";
import { useProfiles } from "../lib/profiles";
import { MODEL_META, deviceModel } from "../lib/types";
import { displayName, rememberDevice, writeNameToDevice } from "../lib/devnames";
import { Button, Card, Spinner } from "./ui";
import { useToast } from "./toast";
import { useConfirm } from "./dialog";

export function BackupPanel() {
  const { hello, drive, send, disconnect } = useDevice();
  const { profiles, saveProfiles } = useProfiles();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState("");

  const model = hello ? deviceModel(hello) : null;

  async function exportBackup() {
    if (!hello || !drive || !model) return;
    setBusy("Reading the keypad…");
    try {
      const name = displayName(undefined, hello.uid);
      const config = JSON.parse(await ipc.driveRead(drive.path, "config.json")) as Record<
        string,
        unknown
      >;
      // macros/ is read file-by-file: over serial each one is its own
      // request, so this is the slow part and gets the progress line.
      const files = await ipc.driveList(drive.path, "macros").catch(() => [] as string[]);
      const macros: Record<string, string> = {};
      for (const [i, file] of files.entries()) {
        setBusy(`Reading macros… (${i + 1}/${files.length})`);
        try {
          macros[file] = await ipc.driveRead(drive.path, `macros/${file}`);
        } catch {
          // A macro that can't be read must not silently vanish from a
          // backup the user will trust later.
          throw new Error(`Couldn't read macros/${file} — try again.`);
        }
      }
      const backup: Backup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        created: new Date().toISOString(),
        app: await getVersion().catch(() => ""),
        device: {
          model,
          fw: hello.fw,
          uid: hello.uid,
          name,
          key_count: hello.key_count,
        },
        config,
        macros,
        // Only the profiles that carry assignments for THIS keypad's macro
        // files would be enough, but a profile is cheap and a missing one is
        // a puzzle — take them all.
        profiles,
      };
      setBusy("Choosing where to save…");
      const path = await save({
        defaultPath: backupFileName(name),
        filters: [{ name: "MKYADA backup", extensions: ["json"] }],
      });
      if (!path) return; // user cancelled the dialog
      setBusy("Writing the file…");
      await ipc.fileWriteText(path, JSON.stringify(backup, null, 2));
      toast.success(
        "Backup saved",
        `${describeBackup(backup)} — from ${name}.`,
      );
    } catch (e) {
      toast.error("Backup failed", String(e));
    } finally {
      setBusy("");
    }
  }

  async function importBackup() {
    if (!hello || !drive || !model) return;
    let backup: Backup;
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "MKYADA backup", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      backup = parseBackup(await ipc.fileReadText(picked));
    } catch (e) {
      toast.error("Couldn't read that backup", String(e));
      return;
    }
    // A Core 6 backup on a Vision 6 (or the reverse) would write a key count
    // and wiring the hardware doesn't have. Refuse rather than "restore" a
    // keypad into a broken state.
    if (backup.device.model !== model) {
      toast.error(
        "That backup is for a different keypad",
        `It came from a ${MODEL_META[backup.device.model].label}; this is a ${MODEL_META[model].label}.`,
      );
      return;
    }
    const target = displayName(undefined, hello.uid);
    const ok = await confirm({
      title: "Restore this backup?",
      message:
        `Restoring "${backup.device.name || "keypad"}" (${describeBackup(backup)}) onto ${target}.\n\n` +
        "Every macro currently on this keypad is deleted and replaced with the backup's. " +
        "Its settings, layer names and nickname are overwritten too.\n\n" +
        "The keypad's model and USB-drive visibility stay as they are. " +
        "The keypad restarts when this finishes.",
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    setBusy("Restoring…");
    try {
      // Delete first: a leftover macro from the old setup would otherwise
      // keep firing on a key the backup leaves unassigned.
      const existing = await ipc.driveList(drive.path, "macros").catch(() => [] as string[]);
      for (const file of existing) {
        if (!(file in backup.macros)) {
          await ipc.driveDelete(drive.path, `macros/${file}`).catch(() => {});
        }
      }
      const names = Object.keys(backup.macros);
      for (const [i, file] of names.entries()) {
        setBusy(`Writing macros… (${i + 1}/${names.length})`);
        await ipc.driveWrite(drive.path, `macros/${file}`, backup.macros[file]);
      }
      setBusy("Writing settings…");
      const current = JSON.parse(await ipc.driveRead(drive.path, "config.json")) as Record<
        string,
        unknown
      >;
      const config = { ...backup.config };
      for (const key of DEVICE_OWNED_CONFIG) {
        if (key in current) config[key] = current[key];
        else delete config[key];
      }
      await ipc.driveWrite(drive.path, "config.json", JSON.stringify(config, null, 2));
      if (backup.profiles.length > 0) {
        setBusy("Restoring profiles…");
        await saveProfiles(mergeProfiles(profiles, backup.profiles));
      }
      if (backup.device.name) {
        await rememberDevice(hello.uid, { name: backup.device.name });
        await writeNameToDevice(drive.path, backup.device.name).catch(() => {});
      }
      setBusy("Restarting the keypad…");
      await ipc.driveEject(drive.path).catch(() => {});
      await send({ t: "reset" }).catch(() => {});
      await disconnect().catch(() => {});
      toast.success(
        "Backup restored",
        "The keypad is restarting — it will reconnect in a few seconds.",
      );
    } catch (e) {
      toast.error("Restore failed", String(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <Card title="Backup & restore">
      {!hello || !drive ? (
        <p className="text-sm text-fg-muted py-2">
          Connect a keypad to back it up or restore one.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">
            A backup is a single JSON file holding this keypad&apos;s macros, key settings, layer
            names, profiles and nickname. Restore it onto the same keypad later, or onto another{" "}
            {MODEL_META[model!].label} to set it up in one go.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void exportBackup()} disabled={!!busy}>
              <Download size={14} aria-hidden /> Back up to a file
            </Button>
            <Button onClick={() => void importBackup()} disabled={!!busy}>
              <Upload size={14} aria-hidden /> Restore from a file
            </Button>
            {busy && (
              <span className="text-xs text-fg-muted flex items-center gap-1.5">
                <Spinner size={12} /> {busy}
              </span>
            )}
          </div>
          <p className="text-xs text-fg-faint">
            Your computer&apos;s own settings — sound output, OBS connection, window behaviour —
            aren&apos;t part of a keypad backup.
          </p>
        </div>
      )}
    </Card>
  );
}
