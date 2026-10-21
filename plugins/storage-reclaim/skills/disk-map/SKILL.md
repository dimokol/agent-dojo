---
name: disk-map
description: Use when someone asks what is taking up space on a disk, folder or external drive on any OS (macOS, Linux, Windows; APFS, NTFS, exFAT, ext4), wants a TreeSize or WinDirStat style map, or wants to know what grew since an earlier scan. Read-only. To actually free space on this Mac, use storage-reclaim, which calls this.
---

# disk-map

A read-only map of one folder or mount: a text summary for you, a clickable treemap page for the person, and a snapshot file you can compare against later. It never deletes anything. If the next step is deleting, the safety rules of a cleanup skill apply (what is in use, whether it's the only copy, and an explicit go per item).

## Run it

```bash
bash <this skill's folder>/scripts/map.sh <path> [out-dir] [depth]
```

- The output folder defaults to `~/.local/state/disk-map`. Depth defaults to 6. Use 3 or 4 for a quick look at a whole disk.
- It writes `<name>-<stamp>.stacks` (the snapshot), `.txt` (the summary it also prints) and `.html` (the treemap), and prints all three paths at the end. Give the person the full path of the `.html` file.
- It needs `dua` (dua-cli) 2.43 or newer and `python3`. On macOS with dua 2.45+ it adds `--deduplicate-apfs-clones`, because a cloned tree otherwise counts twice.
- Sizes are decimal: 1 GB = 10^9 bytes, as Finder shows them. `du -h` shows GiB and reads about 7% lower.
- Folders the scan can't read count as unknown, never as zero. The summary and the page say how many and where.
- On Windows, run it from Git Bash or WSL. Without either, run the steps by hand: `dua -x -f bytes aggregate --no-total -d 6 C:\ | python scripts/report.py convert --header "root=C:\ depth=6" > c.stacks`, then `python scripts/report.py html c.stacks c.html`.
- Never run `dua flamegraph` from an agent: 2.46 always opens the default browser and has no output-file option.
- The `.html` and `.stacks` files list every folder name under the scanned root. Don't share them.

**What grew:** `python3 scripts/report.py diff OLD.stacks NEW.stacks --depth 3`. It lists the paths that grew and shrank, and tags each as NEW or GONE.
- Each snapshot's first line records its root, depth, flags and time. The diff prints that line for both scans and warns when the flags differ (a clone-deduplicated scan reads smaller than a plain one).
- If one scan covers a parent folder of the other, the diff narrows the bigger one on its own. It also caps the depth at what both scans can resolve.
- A snapshot without the header doesn't record its root, so the diff refuses it. Pass `--same-root` if both scans cover the same folder, or `--narrow-old Documents/projects` (the subfolder's path inside the bigger scan).

**Reading the summary:** it shows the largest entries at depth 1 and 2, the largest folders at the scan depth, and a section of folder names that usually hold rebuildable output (`node_modules`, `build`, `Caches`, `worktrees` and similar). A hit there means "look here". It doesn't mean "safe to delete". Browser profiles (`ms-playwright-mcp*`, `*-profile`, `User Data`) get their own line: they hold logins, so only their cache subfolders are rebuildable.

## Numbers that lie, per OS

| Where | Trap | What to do |
|---|---|---|
| macOS | `/` is a sealed system snapshot. Data fills `/System/Volumes/Data` | Scan the Data volume or `~`, and read free space from `df -h /System/Volumes/Data` |
| macOS | "Operation not permitted" under `~/Library` and the media folders (privacy protection) | The scan reports them as unknown. Full Disk Access for the terminal fixes it |
| macOS | Swap files in `/System/Volumes/VM` share the disk's space | `sysctl vm.swapusage`. The space comes back when apps close |
| macOS | Space you can't see in the tree | `tmutil listlocalsnapshots /` for local snapshots, `diskutil info /` for purgeable space, `/System/Library/AssetsV2` for simulator and Siri assets |
| Any | The total of the tree doesn't match the free-space change | Trust `df`. Clones, hardlinks, sparse files and growing swap all make sums wrong |
| Windows | `pagefile.sys`, `hiberfil.sys`, `System Volume Information`, `$RECYCLE.BIN` | Scan as admin. `vssadmin list shadowstorage` shows restore points. WinSxS is mostly hardlinks; ask `Dism /Online /Cleanup-Image /AnalyzeComponentStore` |
| Linux | `/proc` and other pseudo filesystems, Docker overlay layers | Keep `-x`. Use `docker system df` for Docker, `journalctl --disk-usage` for logs, and check btrfs or zfs snapshots |
| exFAT | Large clusters make small files cost far more than their size | Add `-A` to `dua` for apparent size and compare the two |
| NTFS on a Mac | Mounted read-only | Fine for a scan. Clean it up from Windows |
| ext4 on a Mac | Not mounted without macFUSE or ExtendFS | Scan it from Linux instead |
| Spinning disk | Parallel scanning thrashes the drive | `dua -t 1` |

## For the person, interactively

`dua i <path>` and `gdu-go <path>` (Homebrew names it `gdu-go`; elsewhere it's `gdu`) are terminal browsers with keyboard navigation. Suggest them if the person wants to explore without an agent. Neither is needed for the map above.
