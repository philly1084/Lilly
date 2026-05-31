class KimibuiltSuite < Formula
  desc "KimiBuilt Suite online compose bundle installer"
  homepage "https://github.com/philly1084/KimiBuilt"
  url "https://github.com/philly1084/KimiBuilt/releases/download/v1.0.0/kimibuilt-suite-compose-1.0.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "docker"

  def install
    libexec.install Dir["*"]
    chmod 0755, libexec/"install-compose.sh" if (libexec/"install-compose.sh").exist?

    (bin/"kimibuilt-suite").write <<~SH
      #!/usr/bin/env bash
      set -euo pipefail

      bundle_dir="#{libexec}"
      installer="${bundle_dir}/install-compose.sh"
      env_example="${bundle_dir}/templates/release.env.example"
      setup_guide="${bundle_dir}/docs/online-setup.md"

      command="${1:-help}"
      if [ "$#" -gt 0 ]; then
        shift
      fi

      case "$command" in
        help|-h|--help)
          cat <<'USAGE'
      KimiBuilt Suite Homebrew wrapper

      Usage:
        kimibuilt-suite install [install-compose args...]
        kimibuilt-suite doctor
        kimibuilt-suite setup-guide
        kimibuilt-suite env-example
        kimibuilt-suite bundle-path
        kimibuilt-suite help

      Runtime passwords are generated into release.env on the install host.
      USAGE
          ;;
        install)
          if [ ! -x "$installer" ]; then
            echo "Missing executable installer: $installer" >&2
            exit 1
          fi
          exec "$installer" "$@"
          ;;
        doctor)
          echo "KimiBuilt Suite bundle: $bundle_dir"
          if command -v docker >/dev/null 2>&1; then
            docker --version
          else
            echo "docker: not found" >&2
            exit 1
          fi
          if docker compose version >/dev/null 2>&1; then
            docker compose version
          else
            echo "docker compose: not available from the current Docker CLI" >&2
            exit 1
          fi
          if [ -x "$installer" ]; then
            echo "installer: $installer"
          else
            echo "installer: missing or not executable at $installer" >&2
            exit 1
          fi
          ;;
        setup-guide)
          if [ ! -f "$setup_guide" ]; then
            echo "Missing setup guide: $setup_guide" >&2
            exit 1
          fi
          cat "$setup_guide"
          ;;
        env-example)
          if [ ! -f "$env_example" ]; then
            echo "Missing env example: $env_example" >&2
            exit 1
          fi
          cat "$env_example"
          ;;
        bundle-path)
          printf '%s\\n' "$bundle_dir"
          ;;
        *)
          echo "Unknown command: $command" >&2
          echo "Run: kimibuilt-suite help" >&2
          exit 64
          ;;
      esac
    SH
  end

  test do
    assert_match "KimiBuilt Suite Homebrew wrapper", shell_output("#{bin}/kimibuilt-suite help")
    assert_match libexec.to_s, shell_output("#{bin}/kimibuilt-suite bundle-path")
  end

  def caveats
    <<~EOS
      This formula installs the KimiBuilt Suite release compose bundle under:
        #{libexec}

      It also installs a small CLI wrapper:
        kimibuilt-suite

      Trial flow:
        kimibuilt-suite doctor
        kimibuilt-suite install --no-start --print-secrets
        $EDITOR /opt/kimibuilt-suite/release.env
        kimibuilt-suite install --yes

      Requirements:
        - Docker Engine or Docker Desktop must be running.
        - Docker Compose v2 must be available as `docker compose`.
        - Review the generated release.env before starting services.

      Tap maintainers:
        Replace the formula release URL and sha256 before trial use.
    EOS
  end
end
