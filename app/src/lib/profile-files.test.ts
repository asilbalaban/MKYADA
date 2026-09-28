import { describe, expect, it } from "vitest";
import { profileFilePrefix, staleProfileFiles } from "./profile-files";

describe("staleProfileFiles", () => {
  const listing = [
    "key1.json",
    "key3-b.json",
    "meta.json",
    "enc-cw.json",
    "p_pa_key1.json",
    "p_pa_key1.s1.json",
    "p_pa_enc-cw.json",
    "p_pgone_key2.json",
    "p_pgone_key2.vd.json",
    "p_pgone_btn-back.json",
  ];

  it("returns only files of profiles that no longer exist", () => {
    expect(staleProfileFiles(listing, ["pa"])).toEqual([
      "p_pgone_key2.json",
      "p_pgone_key2.vd.json",
      "p_pgone_btn-back.json",
    ]);
  });

  it("sweeps every profile file when no profiles are left", () => {
    expect(staleProfileFiles(listing, [])).toHaveLength(6);
  });

  it("never touches global macros or the meta sidecar", () => {
    expect(staleProfileFiles(listing, [])).not.toContain("meta.json");
    expect(staleProfileFiles(listing, [])).not.toContain("key1.json");
  });

  it("keeps a file when any known id claims it", () => {
    // "p1_x" is a separate id whose files also start with "p_p1_"
    expect(staleProfileFiles(["p_p1_x_key1.json"], ["p1"])).toEqual([]);
  });

  it("builds the prefix saveProfiles writes", () => {
    expect(profileFilePrefix("pabc")).toBe("p_pabc_");
  });
});
