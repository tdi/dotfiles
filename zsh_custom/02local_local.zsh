# Thing that are needed only on my local machine

if [ -z "$SERVER_CONFIG" ]
then 
  export DEBEMAIL="dariusz.dwornikowski@cs.put.poznan.pl"
  export DEBFULLNAME="Dariusz Dwornikowski"
  export GOPATH=$HOME/dev/go
  PATH=$PATH:$HOME/.rvm/bin # Add RVM to PATH for scripting
  PATH=$PATH:/opt/java/bin:~/bin:$GOPATH/bin
  alias dquilt="quilt --quiltrc=${HOME}/.quiltrc-dpkg"

  export BSTINPUTS=.$HOME/share/Bst:
  export BIBINPUTS=.:$HOME/share/Bib:

  export TODOTXT_DEFAULT_ACTION=ls
  alias t="todo.sh -d ${HOME}/.todo.cfg"

  BASE16_SHELL="$HOME/.config/base16-shell/base16-eighties.dark.sh"
  [[ -s $BASE16_SHELL ]] && source $BASE16_SHELL

  export PATH
fi
