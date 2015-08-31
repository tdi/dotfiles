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

if [[ -x `which gpg-agent` ]]; 
then 
  # GPG / SSH
  envfile="$HOME/.gnupg/gpg-agent.env"
  if [[ -e "$envfile" ]] && kill -0 $(grep GPG_AGENT_INFO "$envfile" | cut -d: -f 2) 2>/dev/null; then
    eval "$(cat "$envfile")"
  else
    eval "$(gpg-agent --daemon --write-env-file "$envfile")"
  fi
  export GPG_AGENT_INFO  # the env file does not contain the export statement
fi 

if ! pgrep ssh-agent > /dev/null; then
  ssh-agent > ~/.ssh/.ssh-agent-thing
fi
if [[ "$SSH_AGENT_PID" == "" ]]; then
  eval $(<~/.ssh/.ssh-agent-thing)
fi

ssh-add -l >/dev/null || alias ssh='ssh-add -l >/dev/null || ssh-add && unalias ssh; ssh'

if [[ -x `which keychain` ]];
then
  eval $(keychain --eval --quiet -Q)
fi 

if [[ -x `which linuxlogo` ]];
then
  linuxlogo
fi 
