#!/bin/bash

xrdb -merge ~/.Xresources
export XDG_MENU_PREFIX="lxde-"

if [[ -x `which gpg-agents` ]]; 
then 
  # GPG / SSH
  envfile="$HOME/.gnupg/gpg-agent-info-blackstar"
  if [[ -e "$envfile" ]] && kill -0 $(grep GPG_AGENT_INFO "$envfile" | cut -d: -f 2) 2>/dev/null; then
    eval "$(cat "$envfile")"
  else
    eval "$(gpg-agent --daemon --write-env-file "$envfile")"
  fi
  export GPG_AGENT_INFO  # the env file does not contain the export statement
fi 
 ck-launch-session nm-applet  &
 setxkbmap pl
 xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation" 1
 xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Button" 2
 xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Timeout" 200
 start-pulseaudio-x11
 /usr/lib/x86_64-linux-gnu/lxpolkit &
 xss-lock -- i3lock &
 redshift &
 pidgin &
 slack &
 dunst &
if [ -f $HOME/.Xmodmap ]; then
  /usr/bin/xmodmap ~/.Xmodmap
fi
exec dbus-launch i3 >> /tmp/i3log
