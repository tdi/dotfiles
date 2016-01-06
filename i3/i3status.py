import subprocess
from i3pystatus import Status
from i3pystatus.mail import maildir

status = Status(standalone=True)
status.register("clock",
                format="%a %-d %b %X",)
status.register("battery",
                format="{status} {remaining:%E%hh:%Mm}",
                alert=True,
                alert_percentage=5,
                status={
                    "DIS":  "Discharging",
                    "CHR":  "Charging",
                    "FULL": "Bat full",
                },)
status.register("runwatch",
                name="DHCP",
                path="/var/run/dhclient*.pid",)
status.register("network",
                interface="eth0",
                format_up="{v4cidr}",)
status.register("network",
                interface="wlan0",
                format_up="{essid} {quality:03.0f}%",)

status.register("mail",
                color_unread="#FFFF00",
                backends=[
                    maildir.MaildirMail(directory="/home/tdi/.mail/INBOX"),
                    #maildir.MaildirMail(directory="/home/tdi/.mail/Personal.INBOX"),
                    maildir.MaildirMail(directory="/home/tdi/.mail-tenesys/Inbox")
                    ]
                )
status.run()
