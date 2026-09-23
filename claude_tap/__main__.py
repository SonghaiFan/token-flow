"""Run Token Flow through the commands package."""

from claude_tap.commands.cli import main_entry


def main() -> None:
    main_entry()


if __name__ == "__main__":
    main()
