# Samonaprawiające się selektory dla workflow Automa

```
python3 tools/add_self_healing.py --suffix _heal firma_*.automa.json
python3 tools/add_self_healing.py --upload-check --suffix _heal_upload firma_*.automa.json
```

- `heal_helper.js`: logika wklejana do bloków JS. Element jest szukany kolejno:
  - oryginalnym selektorem
  - wariantem bez hashy
  - zapamiętanymi atrybutami
  - podobnym ułożeniem
  - podobnym tekstem
- `add_self_healing.py`: przed każdym blokiem z selektorem wstawia blok `[heal]`. Selektor bloku dostaje alternatywę `[data-automa-heal~="<id>"]`.
- `--upload-check`: za każdym `upload-file` dodaje kontrolę, czy plik pojawił się na stronie. Jeśli nie, upload jest ponawiany (maks. 3 razy).

Podobne ułożenie i podobny tekst działają dopiero po pierwszym udanym przebiegu. Odciski elementów są zapisywane w localStorage strony. Dziennik napraw jest w zmiennej Automa `heal_log` i w konsoli (`[automa-heal]`).
