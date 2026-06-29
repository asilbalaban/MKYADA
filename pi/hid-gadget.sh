#!/bin/bash
# Pi 5'i host'a USB klavye (hidg0) + absolute mouse (hidg1) olarak tanitir.
#   /dev/hidg0 -> 8 byte boot keyboard raporu
#   /dev/hidg1 -> 6 byte absolute pointer raporu (buttons,X,Y,wheel)
set -e

GADGET=/sys/kernel/config/usb_gadget/macropad

teardown() {
  if [ -d "$GADGET" ]; then
    echo "" > "$GADGET/UDC" 2>/dev/null || true
    rm -f "$GADGET"/configs/c.1/hid.usb0 "$GADGET"/configs/c.1/hid.usb1 2>/dev/null || true
    rmdir "$GADGET"/configs/c.1/strings/0x409 2>/dev/null || true
    rmdir "$GADGET"/configs/c.1 2>/dev/null || true
    rmdir "$GADGET"/functions/hid.usb0 "$GADGET"/functions/hid.usb1 2>/dev/null || true
    rmdir "$GADGET"/strings/0x409 2>/dev/null || true
    rmdir "$GADGET" 2>/dev/null || true
  fi
}

if [ "$1" = "stop" ]; then
  teardown
  echo "Gadget kaldirildi."
  exit 0
fi

# Temiz baslangic
teardown

modprobe libcomposite
mkdir -p "$GADGET"
cd "$GADGET"

echo 0x1d6b > idVendor
echo 0x0104 > idProduct
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB

mkdir -p strings/0x409
echo "asil-macropad-0001" > strings/0x409/serialnumber
echo "Asil"               > strings/0x409/manufacturer
echo "Macro Keyboard"     > strings/0x409/product

mkdir -p configs/c.1/strings/0x409
echo "Config 1" > configs/c.1/strings/0x409/configuration
echo 250        > configs/c.1/MaxPower

# --- hidg0: KLAVYE (8 byte boot keyboard) ---
mkdir -p functions/hid.usb0
echo 1 > functions/hid.usb0/protocol      # 1 = keyboard
echo 1 > functions/hid.usb0/subclass      # 1 = boot
echo 8 > functions/hid.usb0/report_length
printf '\x05\x01\x09\x06\xa1\x01\x05\x07\x19\xe0\x29\xe7\x15\x00\x25\x01\x75\x01\x95\x08\x81\x02\x95\x01\x75\x08\x81\x03\x95\x05\x75\x01\x05\x08\x19\x01\x29\x05\x91\x02\x95\x01\x75\x03\x91\x03\x95\x06\x75\x08\x15\x00\x25\x65\x05\x07\x19\x00\x29\x65\x81\x00\xc0' \
  > functions/hid.usb0/report_desc

# --- hidg1: ABSOLUTE MOUSE (6 byte: buttons, X16, Y16, wheel) ---
mkdir -p functions/hid.usb1
echo 0 > functions/hid.usb1/protocol
echo 0 > functions/hid.usb1/subclass
echo 6 > functions/hid.usb1/report_length
printf '\x05\x01\x09\x02\xa1\x01\x09\x01\xa1\x00\x05\x09\x19\x01\x29\x03\x15\x00\x25\x01\x95\x03\x75\x01\x81\x02\x95\x01\x75\x05\x81\x03\x05\x01\x09\x30\x09\x31\x16\x00\x00\x26\xff\x7f\x75\x10\x95\x02\x81\x02\x09\x38\x15\x81\x25\x7f\x75\x08\x95\x01\x81\x06\xc0\xc0' \
  > functions/hid.usb1/report_desc

# Iki fonksiyonu da config'e bagla
ln -s functions/hid.usb0 configs/c.1/
ln -s functions/hid.usb1 configs/c.1/

# UDC'ye bagla
ls /sys/class/udc > UDC

echo "HID gadget kuruldu -> /dev/hidg0 (klavye), /dev/hidg1 (mouse)"
