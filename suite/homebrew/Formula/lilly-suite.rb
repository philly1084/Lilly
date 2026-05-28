class LillySuite < Formula
  desc "Lilly Suite compose bundle installer"
  homepage "https://github.com/OWNER/REPO"
  url "https://github.com/OWNER/REPO/releases/download/v0.0.0/lilly-suite-compose-bundle-v0.0.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "docker"

  def install
    libexec.install Dir["*"]
    chmod 0755, libexec/"install-compose.sh" if (libexec/"install-compose.sh").exist?

    (bin/"lilly-suite").write <<~SH
      #!/usr/bin/env bash
      set -euo pipefail

      bundle_dir="#{libexec}"
      installer="${bundle_dir}/install-compose.sh"
      env_example="${bundle_dir}/templates/release.env.example"

      command="${1:-help}"
      if [ "$#" -gt 0 ]; then
        shift
      fi

      case "$command" in
        help|-h|--help)
          cat <<'USAGE'
      Lilly Suite Homebrew wrapper

      Usage:
        lilly-suite install [install-compose args...]
        lilly-suite doctor
        lilly-suite env-example
        lilly-suite bundle-path
        lilly-suite help

      This wrapper delegates installation to the bundled install-compose.sh.
      It does not remove containers, volumes, databases, or user data.
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
          echo "Lilly Suite bundle: $bundle_dir"
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
          echo "Run: lilly-suite help" >&2
          exit 64
          ;;
      esac
    SH
  end

  test do
    assert_match "Lilly Suite Homebrew wrapper", shell_output("#{bin}/lilly-suite help")
    assert_match libexec.to_s, shell_output("#{bin}/lilly-suite bundle-path")
  end

  def caveats
    <<~EOS
      This formula installs the Lilly Suite release compose bundle under:
        #{libexec}

      It also installs a small CLI wrapper:
        lilly-suite

      Trial flow:
        lilly-suite doctor
        lilly-suite env-example > .env
        $EDITOR .env
        lilly-suite install

      Requirements:
        - Docker Engine or Docker Desktop must be running.
        - Docker Compose v2 must be available as `docker compose`.
        - Review the generated .env before starting services.

      Safety:
        The Homebrew wrapper does not delete containers, volumes, databases, or
        user data. Any cleanup should be run manually and intentionally.

      Tap maintainers:
        Replace the formula homepage, release URL, and sha256 before trial use.
    EOS
  end
end
