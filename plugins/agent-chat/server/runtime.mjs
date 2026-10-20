const [major,minor] = process.versions.node.split('.').map(Number)
if (major<24 || (major===24 && minor<15)) {
  process.stderr.write('Agent-chat requires Node 24.15 or newer.\n')
  process.exit(1)
}
