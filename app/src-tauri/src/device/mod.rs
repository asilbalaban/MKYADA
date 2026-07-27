pub mod bootloader;
pub mod drive;
pub mod serial;
pub mod serialfs;

/// One directory entry with its size — what the repair diagnosis compares
/// against the bundled firmware. `drive::list_dir`/`serialfs::list_dir` only
/// answer names, which is enough to open a file but not to tell a stale
/// module from a current one.
#[derive(serde::Serialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub dir: bool,
}
