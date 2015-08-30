if [[ -x `which wmname` ]]; 
then 
  wmname LG3D
fi
export DE='xfce'


# Touchpad
if [[ -x `which xinput` ]];
then
  xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation" 1
  xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Button" 2
  xinput set-prop 'TPPS/2 IBM TrackPoint' "Evdev Wheel Emulation Timeout" 200
fi

alias startx='startx -- vt01'
