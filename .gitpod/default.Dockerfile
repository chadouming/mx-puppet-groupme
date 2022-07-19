FROM docker.io/gitpod/workspace-full:latest
LABEL maintainer="Cody Wyatt Neiman (xangelix) <neiman@cody.to>"

ENV DEBIAN_FRONTEND=noninteractive

RUN echo 'debconf debconf/frontend select Noninteractive' | sudo debconf-set-selections && \
    echo keyboard-configuration keyboard-configuration/layout select 'English (US)' | sudo debconf-set-selections && \
    echo keyboard-configuration keyboard-configuration/layoutcode select 'us' | sudo debconf-set-selections && \
    echo 'resolvconf resolvconf/linkify-resolvconf boolean false' | sudo debconf-set-selections

RUN mkdir ~/.fonts && \
    curl -L "https://github.com/ryanoasis/nerd-fonts/releases/download/2.2.0-RC/FiraCode.zip" -o FiraCode.zip && \
    unzip FiraCode.zip -d ~/.fonts/ && \
    rm FiraCode.zip && \
    fc-cache -fv

RUN brew update && brew upgrade
RUN sudo apt update && sudo apt upgrade -yq && sudo apt dist-upgrade -y && \
    sudo apt -yq install debconf-utils
