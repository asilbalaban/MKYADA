# myko — Raspberry Pi 5 Makro Cihazi

Raspberry Pi 5'i bir host bilgisayara **USB HID klavye + mouse** olarak baglayip,
kaydedilmis makrolari bir kisayolla tekrar oynatan sistem.

## Parcalar

- **recorder/** — Windows kayit/duzenleme programi (Python + tkinter + pynput).
  Global klavye+mouse hareketlerini kaydeder, duzenlenebilir, `asil-macro` JSON
  formatinda disa aktarir. GitHub Actions ile `MacroRecorder.exe` olarak derlenir.
- **pi/** — Raspberry Pi tarafi:
  - `hid-gadget.sh` — USB-C'yi HID klavye (`/dev/hidg0`) + absolute mouse
    (`/dev/hidg1`) gadget'i olarak kurar.
  - `proto.py` — uctan uca dogrulama prototipi (Ctrl+1 -> i + mouse + i).
  - (gelecek) oynatma motoru + web arayuzu + tetikleyici daemon.

## Akis

1. Windows'ta `MacroRecorder.exe` ile hareketleri kaydet/duzenle -> JSON.
2. JSON'u Pi web arayuzune yukle, bir kisayol ata (orn. Ctrl+1).
3. Pi'ye takili klavyeden kisayola bas -> Pi makroyu USB HID ile oynatir.

## EXE derleme (GitHub Actions)

`recorder/` altinda degisiklik push'laninca **Build Windows EXE** is akisi calisir;
`MacroRecorder.exe` artifact olarak indirilebilir. Elle tetiklemek icin Actions
sekmesinden "Run workflow".
