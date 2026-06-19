# ATHENA-001 Deployment System

SSH-based deployment with hash-incremental sync, automatic PM2 management, smart RAM limits, versioned releases, and health checks.

---

## Quick Start

```bash
# 1. Konfigürasyon
cp deploy/deploy.json deploy/deploy.json  # veya direkt --host ile kullan

# 2. İlk kurulum (Node.js + PM2 + dizinler)
./deploy.sh init --host ubuntu@192.168.1.100

# 3. Deploy
./deploy.sh deploy --host ubuntu@192.168.1.100
```

---

## Komutlar

| Komut | Açıklama |
|-------|----------|
| `init` | İlk kurulum — remote'da Node.js, PM2, dizin yapısını hazırlar |
| `deploy` | Deploy — hash karşılaştır, sync, build, restart, health check |
| `status` | Servis durumu — PM2 process, health endpoint, deploy meta |
| `logs` | Log izleme — PM2 logları |
| `rollback` | Rollback — eski release'e dön |
| `restart` | Restart — sadece servisi yeniden başlat |
| `cleanup` | Temizlik — eski release'leri sil (keep: N) |
| `doctor` | Diagnostik — remote sistem analizi |
| `config` | Config görüntüle |

---

## Detaylı Kullanım

### init — İlk Kurulum

Remote sunucuyu deploy'a hazırlar:

```bash
./deploy.sh init --host ubuntu@192.168.1.100
```

Yaptıkları:
- Dizin yapısını oluşturur (`/opt/athena/releases/`, `shared/`, vs.)
- Sistem paketlerini kurar (`jq`, `curl`, `git`, `rsync`)
- Node.js kurar (varsa versiyon kontrol eder, yoksa v20 kurar)
- PM2 kurar ve startup ayarlar (`pm2 startup` + `pm2 save`)

### deploy — Deploy

```bash
# Normal deploy
./deploy.sh deploy --host ubuntu@192.168.1.100

# Dry-run (hiçbir şey yapmaz, sadece gösterir)
./deploy.sh deploy --host ubuntu@192.168.1.100 --dry-run

# Detaylı çıktı
./deploy.sh deploy --host ubuntu@192.168.1.100 --verbose
```

Akış:
1. Pre-flight: SSH bağlantı, git info, yerel bağımlılıklar
2. **SHA256 manifest** oluştur → remote ile karşılaştır → değişen dosyaları bul
3. Yeni release dizini oluştur (`releases/v20260619-123456-abc12345/`)
4. **Sadece değişen dosyaları** tar-pipe ile SSH üzerinden gönder
5. `package-lock.json` değişmişse `npm ci` çalıştır; değişmemişse atla
6. `smart-routing-core` → `server` build (tsc)
7. Remote RAM'e göre **akıllı PM2 memory limiti** hesapla
8. PM2 ecosystem config oluştur (cluster mode, instance sayısı, memory limit)
9. **Atomic symlink swap** ile release'i aktifleştir
10. PM2 reload/restart
11. **Health check**: `/health` endpoint'ine 5 kez dene (2sn aralıkla)
12. Health check başarısızsa → **otomatik rollback**
13. Deploy meta yaz (`.deploy-meta.json`)
14. Eski release'leri temizle (son 5 hariç)

### status — Servis Durumu

```bash
./deploy.sh status --host ubuntu@192.168.1.100
```

Gösterir:
- Mevcut release versiyonu
- PM2 process durumu (uptime, memory, CPU)
- Health endpoint yanıtı
- Disk kullanımı
- Son deploy metadatası (versiyon, commit, tarih, node/pm2 versiyon)

### logs — Log İzleme

```bash
# Son 50 satır
./deploy.sh logs --host ubuntu@192.168.1.100

# Son 200 satır
./deploy.sh logs --host ubuntu@192.168.1.100 --lines 200

# Canlı takip
./deploy.sh logs --host ubuntu@192.168.1.100 --follow
```

### rollback — Geri Alma

```bash
# 1 adım geri
./deploy.sh rollback --host ubuntu@192.168.1.100

# 3 adım geri
./deploy.sh rollback --host ubuntu@192.168.1.100 3
```

Atomic symlink değişimi + PM2 restart + health check yapar.

### restart — Servis Yeniden Başlatma

```bash
./deploy.sh restart --host ubuntu@192.168.1.100
```

Build yapmaz, sadece `pm2 restart athena --update-env` çalıştırır.

### cleanup — Eski Release Temizliği

```bash
# Son 5 release'i tut, eskilerini sil
./deploy.sh cleanup --host ubuntu@192.168.1.100

# Son 10 release'i tut
./deploy.sh cleanup --host ubuntu@192.168.1.100 --keep 10
```

### doctor — Sistem Diagnostiği

```bash
./deploy.sh doctor --host ubuntu@192.168.1.100
```

Kontrol eder:
- OS versiyonu, architecture
- RAM (total, available, önerilen Node limiti)
- CPU çekirdek sayısı
- Disk kullanımı
- Node.js varlığı ve versiyonu
- PM2 varlığı ve process listesi
- Mevcut release ve sayısı
- Port dinleme durumu
- System load

### config — Konfigürasyon Görüntüleme

```bash
./deploy.sh config
```

---

## Seçenekler

| Seçenek | Varsayılan | Açıklama |
|---------|-----------|----------|
| `--host` | — | SSH hedefi (`user@hostname`) |
| `--port` | `22` | SSH port |
| `--path` | `/opt/athena` | Remote kurulum dizini |
| `--config` | `deploy/deploy.json` | Config dosyası yolu |
| `--dry-run` | `false` | Simülasyon modu (hiçbir şey yapmaz) |
| `--verbose` | `false` | Detaylı çıktı |
| `--force` | `false` | Onay sorma |

---

## Config Dosyası (`deploy.json`)

```json
{
  "host": "ubuntu@192.168.1.100",
  "port": 22,
  "remotePath": "/opt/athena",
  "nodeVersion": 20,
  "appPort": 3001,
  "keepReleases": 5,
  "sshKey": "/home/ubuntu/.ssh/id_ed25519",
  "healthCheck": {
    "retries": 5,
    "timeout": 5000
  },
  "pm2": {
    "instances": "auto",
    "maxMemoryRestart": ""
  }
}
```

Config dosyasındaki `host` değeri `--host` ile override edilebilir.

---

## Akıllı RAM Hesaplama

PM2 memory limiti remote sunucunun toplam RAM'ine göre otomatik hesaplanır:

| Toplam RAM | Limit | Formül |
|-----------|-------|--------|
| 1 GB (1024MB) | **368 MB** | %36 |
| 2 GB (2048MB) | **512 MB** | %25 |
| 4 GB (4096MB) | **819 MB** | %20 |
| 8 GB (8192MB) | **1024 MB** | %15 → cap |
| 16 GB | **1024 MB** | cap |

- **Floor**: 256 MB
- **Ceiling**: 1024 MB
- Config'de `pm2.maxMemoryRestart` ile manuel override edilebilir

---

## Release Yapısı (Remote)

```
/opt/athena/
├── current → releases/v20260619-123456-abc12345  (symlink)
├── releases/
│   ├── v20260619-123456-abc12345/
│   │   ├── server/
│   │   │   ├── dist/index.js
│   │   │   ├── src/
│   │   │   ├── package.json
│   │   │   ├── node_modules/     (symlink değil, her release kendi)
│   │   │   └── data → ../../shared/data  (symlink)
│   │   ├── smart-routing-core/
│   │   └── ecosystem.config.cjs
│   ├── v20260618-234567-def67890/
│   └── ...
├── shared/
│   ├── data/                     (settings.json, db.json kalıcı)
│   └── logs/                     (PM2 logları)
├── .deploy-manifest.json         (SHA256 manifest)
└── .deploy-meta.json             (son deploy bilgisi)
```

---

## Pratik Örnekler

```bash
# Tümüyle otomatik ilk kurulum + deploy
./deploy.sh init --host ubuntu@10.0.0.5
./deploy.sh deploy --host ubuntu@10.0.0.5

# Hızlı güncelleme (sadece değişen dosyalar gider)
./deploy.sh deploy --host ubuntu@10.0.0.5

# Sorun varsa geri dön
./deploy.sh rollback --host ubuntu@10.0.0.5

# Sunucuyu kontrol et
./deploy.sh doctor --host ubuntu@10.0.0.5

# Config dosyası ile kullan (host config'de tanımlı)
./deploy.sh deploy

# Değişiklikleri gör, ama uygulama
./deploy.sh deploy --host ubuntu@10.0.0.5 --dry-run
```

---

## Notlar

- Root `deploy.sh` → `deploy/deploy.sh`'e yönlendirir. Her iki yoldan da çağırabilirsiniz.
- API anahtarları `server/data/settings.json`'da saklanır. Bu dosya release'ler arasında `shared/data/` üzerinden paylaşılır, her deploy'da sıfırlanmaz.
- Eski `deploy/deploy.sh` (eski git-pull based script) yerine bu yeni sistem kullanılmalıdır.
