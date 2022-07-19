#!/usr/bin/env bash

echo "INFO: Please enter your PGP key password:"
gpg --pinentry-mode=loopback --sign temp.txt

if [ $? -gt 0 ]; then
  echo "FAIL: PGP Password Entry #2 Failed"
  echo "INFO: Please run '.gitpod/init-gpg.2.sh' from the terminal to resume GPG initialization."
  exit 1
fi

rm -f temp.txt temp.txt.gpg
echo "DONE: GPG initialization workaround complete"
