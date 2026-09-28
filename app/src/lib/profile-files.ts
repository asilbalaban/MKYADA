// Which `macros/p_<id>_*` files on the keypad belong to no profile any more.
//
// Every profile override is written as `macros/p_<id>_<slot>.json` (plus its
// `.s1` / `.vd` / `.vh` part files). Deleting a profile used to leave those on
// the drive forever. saveProfiles now lists the macros folder once per sync
// and deletes whatever this returns: right away when the keypad is connected,
// or on the next connect-time sync when it wasn't.

/** Every profile file name starts with this. */
export function profileFilePrefix(id: string): string {
  return `p_${id}_`;
}

/** File names (bare, as `drive_list` returns them) under `macros/` that look
 * like profile files but match none of `knownIds`. A file that matches any
 * known prefix is kept, so an ambiguous name is never deleted. */
export function staleProfileFiles(listing: string[], knownIds: string[]): string[] {
  const prefixes = knownIds.map(profileFilePrefix);
  return listing.filter(
    (f) =>
      f.startsWith("p_") &&
      f.endsWith(".json") &&
      !prefixes.some((pre) => f.startsWith(pre)),
  );
}
