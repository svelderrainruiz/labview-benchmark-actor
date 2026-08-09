Vagrant.configure("2") do |config|
  config.vm.communicator = "ssh"
  config.vm.guest = :ubuntu
  config.vm.boot_timeout = 1800
  config.ssh.username = "actor"
  config.ssh.insert_key = true

  config.vm.provision "verify-lba-base", type: "shell", privileged: true, inline: <<~'SHELL'
    set -euo pipefail
    receipt=/var/lib/lba-cleanroom/base-bootstrap-receipt.json
    test -r "$receipt"
    python3 - "$receipt" <<'PY'
    import json
    import pathlib
    import sys

    receipt = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    required = (
        receipt.get("schema") == "labview-benchmark-actor/ubuntu-base-bootstrap@1",
        receipt.get("outcome") == "PASS",
        receipt.get("failures") == [],
        receipt.get("os", {}).get("version") == "24.04",
        receipt.get("tools", {}).get("git", {}).get("path") == "/usr/bin/git",
        receipt.get("tools", {}).get("sshd", {}).get("path") == "/usr/sbin/sshd",
        receipt.get("tools", {}).get("virtualBoxGuestService", {}).get("path") == "/usr/sbin/VBoxService",
        receipt.get("services", {}).get("ssh", {}).get("activeState") == "active",
        receipt.get("services", {}).get("ssh", {}).get("enabledState") == "enabled",
        receipt.get("services", {}).get("virtualBoxGuestUtils", {}).get("activeState") == "active",
        receipt.get("services", {}).get("virtualBoxGuestUtils", {}).get("enabledState") == "enabled",
    )
    if not all(required):
        raise SystemExit("LBA Ubuntu base receipt is missing or stale")
    PY
  SHELL
end