#!/bin/bash

echo "Install prerequisites"

install_prereq() {
  if [ ! -f /usr/bin/zsh ]
  then
    sudo apt-get install zsh
  fi

  if [ ! -f /usr/bin/git ]
  then
    sudo apt-get install git
  fi 
}

setup_ohmyzsh() {
  if [ ! -d $HOME/.oh-my-zsh ]
  then
    git clone http://github.com/robbyrussell/oh-my-zsh.git
  fi         
}


install_prereq

DOTFILES=$HOME/dotfiles
DOTFILES_BACKUP=$(mktemp -d $HOME/dotfiles_backupXXXX)
echo "Saving backup in $DOTFILES_BACKUP"
cd $DOTFILES

files="bashrc bash gitconfig zshrc zsh_custom devscripts dput.cf xinitrc"


for file in $files; do
  echo "Backup file: $file"
  mv -f $HOME/.$file $DOTFILES_BACKUP/ 
  echo "Symlink file: $file"
  ln -s "$DOTFILES/$file" "$HOME/.$file"
done 

setup_ohmyzsh
