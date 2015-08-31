
if [ -z "$SERVER_CONFIG" ]
then 
  if [[ -x `which wmname` && ! -z $DISPLAY ]]; 
  then 
    wmname LG3D
  fi
  export DE='xfce'
  alias startx='startx -- vt01'
fi
