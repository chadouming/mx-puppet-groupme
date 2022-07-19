#!/usr/bin/env bash

echo "INFO: Please enter your PGP key password:"
gpg --pinentry-mode=loopback --import /home/gitpod/pkey.key

if [ $? -gt 0 ]; then
  echo "FAIL: PGP Password Entry #1 Failed"
  echo "INFO: Please run '.gitpod/init-gpg.1.sh' from the terminal to resume GPG initialization."
  exit 1
fi

echo "STAT: GPG private key imported"

git config --global user.signingkey $GPG_KEY_ID
git config --global commit.gpgsign true
git config --global user.email $GIT_EMAIL
echo "STAT: GPG private key ID and email set in git"

test -r ~/.bash_profile && echo 'export GPG_TTY=$(tty)' >> ~/.bash_profile
echo 'export GPG_TTY=$(tty)' >> ~/.profile
echo "STAT: GPG private key set in bash"

printf "allow-loopback-pinentry\ndefault-cache-ttl 34560000\nmax-cache-ttl 34560000\ndefault-cache-ttl-ssh 34560000\nmax-cache-ttl-ssh 34560000" >> /home/gitpod/.gnupg/gpg-agent.conf
echo "pinentry-mode loopback" >> /home/gitpod/.gnupg/gpg.conf
gpg-connect-agent reloadagent /bye
touch temp.txt
echo "STAT: Prepared for signing test"

# Continues in ./init-gpg.2.sh
$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )/init-gpg.2.sh
