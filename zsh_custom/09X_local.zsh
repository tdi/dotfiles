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

if [[ -x `which ssh-agent` ]];
then

  if ! pgrep ssh-agent > /dev/null; then
    ssh-agent > ~/.ssh/.ssh-agent-thing
  fi
  if [[ "$SSH_AGENT_PID" == "" ]]; then
    eval $(<~/.ssh/.ssh-agent-thing)
  fi
fi

if [ -z "$SERVER_CONFIG" ]
then 
  if [[ -x `which wmname` && ! -z $DISPLAY ]]; 
  then 
    wmname LG3D
  fi
  export DE='xfce'
  alias startx='startx -- vt01'
fi
