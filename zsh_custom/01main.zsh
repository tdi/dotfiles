export LC_MESSAGES=en_GB.UTF-8

if [ -n "$TMUX" ]; then 
  TERM='screen-256color'
fi
if [ -z "$DISPLAY" ]; then
  TERM='xterm-color'
fi

export TERM
export EDITOR=vim
export LESS="-R"

if [ -f $HOME/.dircolors ]; then
  eval $(dircolors $HOME/.dircolors)
fi

# Aliases
alias ls='ls --color=auto'
alias ipy='ipython'
alias ipy2='ipython2'
alias grep='grep --color=auto'
alias n="nvim"
# Paths


if [[ -x `which keychain` ]];
then
  eval $(keychain --eval --quiet -Q)
fi 

if [[ -x `which ssh-agent` ]];
then 
  ssh-add -l >/dev/null || alias ssh='ssh-add -l >/dev/null || ssh-add && unalias ssh; ssh'
fi

if [[ -x `which linuxlogo` ]];
then
  linuxlogo
fi 
