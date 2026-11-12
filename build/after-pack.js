// electron-builder after-pack hook for Open Design Linux.
//
// The upstream app is built for macOS and launched with argv stamps baked in by
// the packaged entry. On Linux we:
//   1. Rename the Electron executable to open-design.bin and write a bash
//      wrapper at `open-design` that sets sandbox/wayland/gpu flags before exec.
//   2. Patch the .desktop file: StartupWMClass, MimeType (od:// scheme),
//      Categories, and the %U Exec arg.
//   3. Strip macOS-only Mach-O artifacts that slipped through DMG extraction
//      (the standalone server's prebuild-install binaries, vela CLI, etc.) so
//      the .deb doesn't ship dead weight.
const fs = require("fs");
const path = require("path");

const EXECUTABLE_NAME = "open-design";

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") {
    return;
  }

  const appOutDir = context.appOutDir;
  const executablePath = path.join(appOutDir, EXECUTABLE_NAME);
  const binaryPath = `${executablePath}.bin`;

  if (!fs.existsSync(executablePath)) {
    throw new Error(`Expected Electron executable not found: ${executablePath}`);
  }

  // Only rename once; electron-builder reuses the unpacked dir across targets.
  if (!fs.existsSync(binaryPath)) {
    fs.renameSync(executablePath, binaryPath);
  }

  const wrapper = `#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "\${BASH_SOURCE[0]}")")" && pwd)"
ELECTRON_BIN="\${APP_DIR}/${EXECUTABLE_NAME}.bin"

# --- Config home resolution ---
XDG_CONFIG_HOME="\${XDG_CONFIG_HOME:-\${HOME}/.config}"

# --- SingletonLock stale cleanup ---
cleanup_singleton_lock() {
  local config_home="\${XDG_CONFIG_HOME}"
  local lock_found=""
  for candidate in "\${config_home}/Open Design/SingletonLock" "\${config_home}/open-design/SingletonLock"; do
    if [[ -L "\${candidate}" ]]; then
      lock_found="\${candidate}"
      break
    fi
  done
  if [[ -n "\${lock_found}" ]]; then
    local target
    target="$(readlink "\${lock_found}")" || return 0
    local pid
    pid="\${target##*-}"
    if [[ "\${pid}" =~ ^[0-9]+$ ]]; then
      if ! kill -0 "\${pid}" 2>/dev/null; then
        rm -f "\${lock_found}"
      fi
    fi
  fi
}

# --- vela CLI (issue #1) ---
# Sign-in shells out to vela. We ship a Linux build at
# resources/open-design/bin/vela (installed by fix-linux-binaries.sh);
# point the app at it unless the user overrode VELA_BIN already.
if [[ -z "\${VELA_BIN:-}" && -x "\${APP_DIR}/resources/open-design/bin/vela" ]]; then
  export VELA_BIN="\${APP_DIR}/resources/open-design/bin/vela"
fi

# --- Doctor diagnostic ---
run_doctor() {
  echo "=== Open Design Desktop Doctor Report ==="
  echo ""
  echo "--- Display Server ---"
  if [[ -n "\${WAYLAND_DISPLAY:-}" ]]; then
    echo "  Wayland detected: WAYLAND_DISPLAY=\${WAYLAND_DISPLAY}"
  else
    echo "  Wayland: not detected (WAYLAND_DISPLAY unset)"
  fi
  if [[ -n "\${XDG_SESSION_TYPE:-}" ]]; then
    echo "  XDG_SESSION_TYPE=\${XDG_SESSION_TYPE}"
  fi
  echo "  OD_USE_X11=\${OD_USE_X11:-unset}"
  echo "  OD_USE_WAYLAND=\${OD_USE_WAYLAND:-unset}"
  echo ""
  echo "--- GPU ---"
  echo "  OD_DISABLE_GPU=\${OD_DISABLE_GPU:-unset}"
  echo "  OD_GL_BACKEND=\${OD_GL_BACKEND:-unset}"
  echo ""
  echo "--- Sandbox ---"
  local sandbox="\${APP_DIR}/chrome-sandbox"
  if [[ -e "\${sandbox}" ]]; then
    echo "  chrome-sandbox path: \${sandbox}"
    echo "  chrome-sandbox permissions: $(stat -c '%a' "\${sandbox}" 2>/dev/null || echo 'unknown')"
    echo "  chrome-sandbox owner: $(stat -c '%U:%G' "\${sandbox}" 2>/dev/null || echo 'unknown')"
  else
    echo "  chrome-sandbox: not found at \${sandbox}"
  fi
  echo ""
  echo "--- Platform ---"
  echo "  OS: $(uname -s)"
  echo "  Arch: $(uname -m)"
  echo "  Kernel: $(uname -r)"
  echo ""
  echo "--- Electron ---"
  echo "  Binary: \${ELECTRON_BIN}"
  if [[ -x "\${ELECTRON_BIN}" ]]; then
    echo "  Status: executable"
    echo "  Version: $(\"\${ELECTRON_BIN}\" --version 2>/dev/null || echo unknown)"
  else
    echo "  Status: MISSING or not executable"
  fi
  echo ""
  echo "--- Resources ---"
  local res="\${APP_DIR}/resources"
  for sub in app open-design open-design-web-standalone open-design-config.json; do
    if [[ -e "\${res}/\${sub}" ]]; then
      echo "  \${sub}: present"
    else
      echo "  \${sub}: MISSING"
    fi
  done
  echo ""
  echo "=== End of Report ==="
}

for arg in "$@"; do
  if [[ "\${arg}" == "--doctor" ]]; then
    run_doctor
    exit 0
  fi
done

export NODE_ENV="\${NODE_ENV:-production}"
export ELECTRON_FORCE_IS_PACKAGED="\${ELECTRON_FORCE_IS_PACKAGED:-1}"

extra_args=()

# --- Sandbox ---
# chrome-sandbox needs setuid root (handled by postinst). When the user opts out
# or the sandbox is not setuid, run unsandboxed so the app still launches.
if [[ "\${OD_DISABLE_SANDBOX:-0}" == "1" ]]; then
  extra_args+=(--no-sandbox --disable-gpu-sandbox)
else
  sandbox="\${APP_DIR}/chrome-sandbox"
  if [[ -e "\${sandbox}" ]]; then
    sandbox_mode="$(stat -c '%a' "\${sandbox}" 2>/dev/null || echo '')"
    sandbox_uid="$(stat -c '%u' "\${sandbox}" 2>/dev/null || echo '')"
    if [[ "\${sandbox_uid}" != "0" || "\${sandbox_mode}" != "4755" ]]; then
      extra_args+=(--no-sandbox --disable-gpu-sandbox)
    fi
  else
    extra_args+=(--no-sandbox --disable-gpu-sandbox)
  fi
fi

# --- Display server / Wayland ---
if [[ "\${OD_USE_X11:-}" == "1" ]]; then
  extra_args+=(--ozone-platform=x11)
elif [[ "\${OD_USE_WAYLAND:-}" == "1" ]]; then
  extra_args+=(--ozone-platform=wayland --enable-features=WaylandWindowDecorations)
elif [[ -n "\${WAYLAND_DISPLAY:-}" ]]; then
  extra_args+=(--ozone-platform=wayland --enable-features=WaylandWindowDecorations)
else
  extra_args+=(--ozone-platform=x11)
fi

# --- Vulkan ---
if [[ "\${OD_DISABLE_VULKAN:-}" == "1" ]]; then
  extra_args+=(--disable-features=Vulkan)
fi

# --- GL backend ---
if [[ -n "\${OD_GL_BACKEND:-}" ]]; then
  extra_args+=(--use-gl="\${OD_GL_BACKEND}")
fi

# --- Password store ---
if [[ -n "\${OD_PASSWORD_STORE:-}" ]]; then
  extra_args+=(--password-store="\${OD_PASSWORD_STORE}")
else
  extra_args+=(--password-store=basic)
fi

cleanup_singleton_lock

exec "\${ELECTRON_BIN}" "\${extra_args[@]}" "$@"
`;

  fs.writeFileSync(executablePath, wrapper, { mode: 0o755 });
  fs.chmodSync(binaryPath, 0o755);

  // Headless daemon CLI wrapper (issue #2). Ships as `open-design-cli` next to
  // the GUI launcher in both .deb (/opt/Open Design/open-design-cli) and
  // AppImage. Runs the bundled daemon CLI through Electron's Node runtime
  // without opening a window, so MCP sessions survive GUI close. The .deb
  // postinst symlinks /usr/local/bin/open-design -> this wrapper (named
  // open-design instead of `od` to avoid colliding with GNU coreutils od).
  const cliWrapperPath = path.join(appOutDir, `${EXECUTABLE_NAME}-cli`);
  const cliWrapper = `#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "\${BASH_SOURCE[0]}")")" && pwd)"
ELECTRON_BIN="\${APP_DIR}/${EXECUTABLE_NAME}.bin"
DAEMON_CLI="\${APP_DIR}/resources/app/prebundled/daemon/daemon-cli.mjs"

if [[ ! -x "\${ELECTRON_BIN}" ]]; then
  echo "open-design-cli: Electron runtime not found: \${ELECTRON_BIN}" >&2
  exit 1
fi
if [[ ! -f "\${DAEMON_CLI}" ]]; then
  echo "open-design-cli: bundled daemon CLI not found: \${DAEMON_CLI}" >&2
  echo "This payload predates the daemon CLI entrypoint; update the package." >&2
  exit 1
fi

export ELECTRON_FORCE_IS_PACKAGED="\${ELECTRON_FORCE_IS_PACKAGED:-1}"
export NODE_ENV="\${NODE_ENV:-production}"

exec env ELECTRON_RUN_AS_NODE=1 "\${ELECTRON_BIN}" "\${DAEMON_CLI}" "$@"
`;
  fs.writeFileSync(cliWrapperPath, cliWrapper, { mode: 0o755 });

  // Patch the .desktop entry(ies) electron-builder emitted.
  const desktopFiles = fs
    .readdirSync(appOutDir)
    .filter((file) => file.endsWith(".desktop"));
  for (const desktopFilename of desktopFiles) {
    const desktopFile = path.join(appOutDir, desktopFilename);
    let desktop = fs.readFileSync(desktopFile, "utf8");

    desktop = desktop.replace(/^Exec=.*$/gm, `Exec=${EXECUTABLE_NAME} %U`);

    // StartupWMClass MUST match the WM_CLASS the running app reports, otherwise
    // GNOME/KDE docks cannot match the window to this desktop entry and
    // "Pin to dash" / "Add to Favorites" stays unavailable. Empirically
    // (verified via xprop on X11) Open Design reports:
    //   WM_CLASS(STRING) = "open design", "Open Design"
    // GNOME matches the second field (the class), so StartupWMClass = "Open Design".
    desktop = desktop.replace(
      /^StartupWMClass=.*$/gm,
      "StartupWMClass=Open Design",
    );
    if (!/^StartupWMClass=/m.test(desktop)) {
      desktop = desktop.replace(
        /(\n\[Desktop Action[^\]]*\]|$)/,
        "StartupWMClass=Open Design\n$1",
      );
    }
    if (!/^MimeType=/m.test(desktop)) {
      desktop = desktop.replace(
        /(\n\[Desktop Action[^\]]*\]|$)/,
        "MimeType=x-scheme-handler/od;\n$1",
      );
    }
    desktop = desktop.replace(
      /^Categories=.*$/gm,
      "Categories=Graphics;Development;Utility;",
    );

    fs.writeFileSync(desktopFile, desktop);

    // GNOME on Wayland matches a running window to its .desktop entry by
    // deriving a desktop filename from the WM_CLASS: it lowercases the class
    // and replaces spaces with dashes, then looks for that file. Our WM_CLASS
    // is "Open Design", so GNOME looks for "Open-design.desktop" — NOT the
    // "open-design.desktop" electron-builder emits from executableName.
    // Without the correctly-named file, GNOME shows a generic icon and never
    // offers "Add to Favorites" for the running window. Write a second copy
    // under the GNOME-expected name (keep the original for other DEs / X11).
    if (desktopFilename === `${EXECUTABLE_NAME}.desktop`) {
      const gnomeName = "Open-design.desktop";
      fs.copyFileSync(desktopFile, path.join(appOutDir, gnomeName));
    }
  }

  // Drop macOS-only Mach-O artifacts that 7z carried over from the DMG. These
  // cannot run on Linux and only bloat the package. We walk the resources tree
  // and delete any Mach-O file (better_sqlite3.node is already replaced with an
  // ELF by build-native.sh, so it survives because it is ELF).
  stripMachOArtifacts(path.join(appOutDir, "resources"));

  // Recreate any pnpm symlinks dropped during DMG extraction from the .pnpm
  // store, in case afterPack runs against a freshly extracted payload. This
  // also repairs dangling/absolute scoped links left by older extractors.
  const webStandaloneNodeModules = path.join(
    appOutDir,
    "resources",
    "open-design-web-standalone",
    "node_modules",
  );
  relinkPnpmStore(webStandaloneNodeModules);
  assertPortablePnpmLinks(webStandaloneNodeModules);
};

function stripMachOArtifacts(dir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripMachOArtifacts(full);
      continue;
    }
    if (!entry.isFile()) continue;
    // Read first 4 bytes: Mach-O magic is 0xCAFEBABE (fat) / FEEDFACE/FEEDFACF
    // (mach-o 32/64) / CFFAEDFE/CEFAEDFE (swapped). We only delete Mach-O;
    // never touch ELF (\\x7fELF) or anything else.
    let fd;
    try {
      fd = fs.openSync(full, "r");
    } catch {
      continue;
    }
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (n < 4) continue;
    const m = buf.readUInt32BE(0);
    const isMachO =
      m === 0xcafebabe ||
      m === 0xfeedface ||
      m === 0xfeedfacf ||
      m === 0xcffaedfe ||
      m === 0xcefaedfe;
    if (isMachO) {
      fs.rmSync(full, { force: true });
    }
  }
}

function relinkPnpmStore(nmDir) {
  if (!nmDir || !fs.existsSync(nmDir)) return;
  const store = path.join(nmDir, ".pnpm", "node_modules");
  if (!fs.existsSync(store)) return;

  const isInside = (base, target) => {
    const relative = path.relative(base, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const replaceWithStoreLink = (full, rel) => {
    const storeTarget = path.join(store, rel);
    if (!fs.existsSync(storeTarget)) return false;
    const linkTarget = path.relative(path.dirname(full), storeTarget);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmdirSync(full);
    else fs.unlinkSync(full);
    fs.symlinkSync(linkTarget, full, "dir");
    console.log(`  relinked ${rel} -> ${linkTarget}`);
    return true;
  };

  const relinkIfNeeded = (full, rel) => {
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      let resolved;
      try {
        resolved = path.resolve(path.dirname(full), fs.readlinkSync(full));
      } catch {
        return;
      }
      // Leave links that stay inside this node_modules tree and resolve.
      // Repoint broken links and links that escape into a build/install path.
      if (fs.existsSync(resolved) && isInside(nmDir, resolved)) return;
      replaceWithStoreLink(full, rel);
      return;
    }
    // 7z replaces symlinks it refuses to write with zero-byte regular files.
    if (stat.isFile() && stat.size === 0) {
      replaceWithStoreLink(full, rel);
    }
  };

  const visit = (dir, prefix, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".pnpm") continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      relinkIfNeeded(full, rel);
      // pnpm stores scoped packages one level deeper: @scope/name.
      if (depth === 0 && entry.isDirectory() && entry.name.startsWith("@")) {
        visit(full, rel, depth + 1);
      }
    }
  };

  visit(nmDir, "", 0);
}

function assertPortablePnpmLinks(nmDir) {
  if (!nmDir || !fs.existsSync(nmDir)) return;
  const escapes = [];
  const check = (full, rel) => {
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return;
    }
    if (!stat.isSymbolicLink()) return;
    const target = fs.readlinkSync(full);
    const resolved = path.resolve(path.dirname(full), target);
    const relative = path.relative(nmDir, resolved);
    const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (!fs.existsSync(resolved) || !inside) {
      escapes.push(`${rel} -> ${target}`);
    }
  };

  let entries;
  try {
    entries = fs.readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".pnpm") continue;
    const full = path.join(nmDir, entry.name);
    check(full, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      let scoped;
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        check(path.join(full, child.name), path.join(entry.name, child.name));
      }
    }
  }

  if (escapes.length > 0) {
    throw new Error(
      `packaged pnpm symlinks resolve outside ${nmDir}:\n${escapes.map((line) => `  ${line}`).join("\n")}`,
    );
  }
}
