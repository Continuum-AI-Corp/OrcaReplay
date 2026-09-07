# Ships only the MCP server, not the recorder.
#
# Recording works by wrapping a process on the host — a local proxy, a PATH shim, a shadow git
# index. None of that survives a container boundary, so `orca record` inside here would watch an
# empty namespace. What does travel is the read side: the six MCP tools serve runs that already
# exist on disk, so a client mounts its `.orca` directory and reads it.
#
#   docker run -i --rm -v "$PWD/.orca:/work/.orca:ro" orcareplay
#
# Read-only is deliberate. `orca_replay` and `orca_compare` execute a real agent and can spend
# money, so a container that only ever reads is the honest default; drop `:ro` if you mean to
# fork from in here.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /work

# Pinned, not `latest`: an image that silently changes what it runs is the opposite of the point.
RUN npm install -g --omit=dev orcareplay@0.2.2

# stdio transport — the client owns stdin/stdout, so no port is exposed.
ENTRYPOINT ["orca", "mcp"]
