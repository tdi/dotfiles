#!/usr/bin/python3
import subprocess
import sys

data = sys.stdin.readlines()[0]
test = subprocess.Popen(["i3-msg", "[con_mark=\"{}\"] focus".format(data[0])], stdout=subprocess.PIPE)

