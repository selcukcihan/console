#!/usr/bin/env python3
import sys
import os


def main():
    from base import initialize

    initialize()

    _, *args = sys.argv
    command = " ".join(args)
    os.system(command)


if __name__ == "__main__":
    main()
