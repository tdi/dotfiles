#!/bin/bash

xrdb -merge ~/.Xresources
export XDG_MENU_PREFIX="lxde-"

ck-launch-session nm-applet  &
 setxkbmap pl
 xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation" 1
 xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Button" 2
 xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Timeout" 200
 start-pulseaudio-x11
 /usr/lib/x86_64-linux-gnu/lxpolkit &
 xss-lock -- i3lock -i /home/tdi/share/wallpapers/deb_bulbs.png &
 redshift &
 dunst &
if [ -f $HOME/.Xmodmap]; then
  /usr/bin/xmodmap ~/.Xmodmap
fi
exec dbus-launch i3 >> /tmp/i3log
