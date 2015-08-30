wmname LG3D
DEBEMAIL="dariusz.dwornikowski@cs.put.poznan.pl"
DEBFULLNAME="Dariusz Dwornikowski"
export DEBEMAIL DEBFULLNAME
export GOPATH=/home/tdi/dev/go
export LC_MESSAGES=en_GB.UTF-8
export DE='xfce'
source /etc/bash_completion.d/virtualenvwrapper
source /etc/bash_completion 
#xhost +localhost 
if [ -n "$TMUX" ]; then 
  TERM='screen-256color'
fi
if [ -z "$DISPLAY" ]; then
  TERM='xterm-color'
fi
export TERM
export EDITOR=vim
export LESS="-R"
eval $(dircolors $HOME/.dircolors)
# Aliases
alias dquilt="quilt --quiltrc=${HOME}/.quiltrc-dpkg"
complete -F _quilt_completion $_quilt_complete_opt dquilt
alias ls='ls --color=auto'
alias ipy='ipython'
alias ipy2='ipython2'
alias startx='startx -- vt01'
alias grep='grep --color=auto'
alias n="nvim"
export TODOTXT_DEFAULT_ACTION=ls
alias t='todo.sh -d /home/tdi/.todo.cfg'

# Paths
PATH=$PATH:/opt/java/bin:~/bin:$GOPATH/bin
export SUDO_HOME=$(eval "echo ~$SUDO_USER")
export BSTINPUTS=.$HOME/share/Bst:
export BIBINPUTS=.:$HOME/share/Bib:
export PATH


# Prompt and shell
shopt -s checkwinsize

color_prompt=yes
force_color_prompt=yes

if [ "$color_prompt" = yes ]; then
  PS1='\[\e[0;32m\]\u@\h\[\e[m\] \[\e[1;34m\]\w\[\e[m\] \[\e[1;32m\]\$\[\e[m\] '
else
    PS1='\u@\h:\w\$ '
fi

# export PROMPT_COMMAND="_update_ps1"
# Touchpad
xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation" 1
xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Button" 2
xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Timeout" 200

PATH=$PATH:$HOME/.rvm/bin # Add RVM to PATH for scripting

# GPG / SSH
envfile="$HOME/.gnupg/gpg-agent.env"
if [[ -e "$envfile" ]] && kill -0 $(grep GPG_AGENT_INFO "$envfile" | cut -d: -f 2) 2>/dev/null; then
    eval "$(cat "$envfile")"
else
    eval "$(gpg-agent --daemon --write-env-file "$envfile")"
    #eval "$(gpg-agent --daemon --enable-ssh-support --write-env-file "$envfile")"
fi
export GPG_AGENT_INFO  # the env file does not contain the export statement
#export SSH_AUTH_SOCK   # enable gpg-agent for ssh

if ! pgrep ssh-agent > /dev/null; then
    ssh-agent > ~/.ssh/.ssh-agent-thing
fi
if [[ "$SSH_AGENT_PID" == "" ]]; then
    eval $(<~/.ssh/.ssh-agent-thing)
fi
ssh-add -l >/dev/null || alias ssh='ssh-add -l >/dev/null || ssh-add && unalias ssh; ssh'

eval $(keychain --eval --quiet -Q )
linuxlogo
