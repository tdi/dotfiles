if status is-interactive
    # Commands to run in interactive sessions can go here
# starship init fish | source

end

# if test -z (pgrep ssh-agent)
#   eval (ssh-agent -c)
#   set -Ux SSH_AUTH_SOCK $SSH_AUTH_SOCK
#   set -Ux SSH_AGENT_PID $SSH_AGENT_PID
#   set -Ux SSH_AUTH_SOCK $SSH_AUTH_SOCK
# end

#/Users/darek/.bun/_bun | source 

/opt/homebrew/bin/brew shellenv | source


alias vim='nvim'
alias kubectl='kubecolor'

# Stupid 
source (brew --prefix)/share/google-cloud-sdk/path.fish.inc
set -gx  USE_GKE_GCLOUD_AUTH_PLUGIN 1
# Added by LM Studio CLI (lms)
set -gx PATH $PATH /Users/darek/.lmstudio/bin
# End of LM Studio CLI section



abbr -a -- lg lazygit
abbr -a -- k kubectl
abbr -a -- cdp 'cd ~/Projects/(ls ~/Projects/ | fzf)'

fish_add_path /usr/local/sbin /Users/darek/.local/bin /Users/darek/.cargo/bin


# peon-ping quick controls
function peon; bash /Users/darek/.claude/hooks/peon-ping/peon.sh $argv; end
~/.local/bin/mise activate fish | source
