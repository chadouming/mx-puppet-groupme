#!/usr/bin/env bash

echo "INFO: Setting SSH private key permissions."
sudo chmod 600 /home/gitpod/.ssh/id_rsa

echo "INFO: Please enter your SSH key password:"
ssh-keygen -y -f ~/.ssh/id_rsa > /home/gitpod/.ssh/id_rsa.pub

if [ $? -gt 0 ]; then
  echo "FAIL: SSH Key Password Entry Failed"
  echo "INFO: Please run '.gitpod/init-gpg.0.sh' from the terminal to resume SSH initialization."
  exit 1
fi

$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )/init-gpg.1.sh
