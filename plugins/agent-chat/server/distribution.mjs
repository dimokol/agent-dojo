// The defaults that differ between this plugin and the author's own install, which ships its
// own copy of this file. All other code is the same in both.
export const distribution = Object.freeze({
  // The chat folder, under the user's home, when AGENT_CHAT_ROOT is unset.
  chatRoot: ['.agent-chat'],
  // 'off': wake-ups never pause after a Claude Code update. AGENT_CHAT_VERSION_CHECK=on overrides it.
  versionCheck: 'off',
  // How the user runs the unread command.
  unreadCommand: '/agent-chat:unread',
})
