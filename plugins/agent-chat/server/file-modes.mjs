// Owner and mode checks that work on every OS. On Windows, Node reports uid 0 and made-up mode
// bits for every file, so these pass there and privacy comes from the folder's ACL (platform.mjs).
// No imports: the status-line widget loads this.
export const WINDOWS = process.platform === 'win32'
const UID = WINDOWS ? -1 : process.getuid()

export const ownedByMe = stat => WINDOWS || stat.uid === UID
// For ancestors of a path, where root-owned system folders (/, /Users) are fine.
export const ownedByMeOrRoot = stat => WINDOWS || stat.uid === UID || stat.uid === 0
export const hasModeBits = (stat, mask) => !WINDOWS && (stat.mode & mask) !== 0
export const modeIs = (stat, mode) => WINDOWS || (stat.mode & 0o777) === mode
