# {{PROJECT_NAME}} — Agent Guide

> Bu doküman, {{PROJECT_NAME}} projesinde çalışan AI ajanları (coding agent'ları) için kapsamlı bir bağlam ve çalışma rehberidir. İnsan kullanıcıya yönelik hızlı başlangıç değildir; `README.md` onun içindir. Buradaki bilgiler, kod değişikliği yapmadan önce bilinmesi gereken mimari, teknoloji yığını, konvansiyonlar ve dikkat edilmesi gereken kritik kuralları içerir.

---

## 0. AGENTS.md Güncelleme ve Doğruluk Kuralı

> **Bu dosyanın güncelliği ve doğruluğu, projenin sürdürülebilirliği için kritiktir.**
> **Bu dosya, tüm AI ajanlarının (agent'ların) çalışma prensiplerini belirler; her ajan değişiklik yaptıktan sonra bu dosyayı güncellemek ve değişiklik özetini kullanıcıya göstermek ZORUNLUDUR.**

- Her kod değişikliği, mimari değişikliği veya yeni özellik eklenmesi sonrasında, bu `AGENTS.md` dosyasındaki ilgili bölümler gözden geçirilmeli ve gerekirse güncellenmelidir.
- Eğer bir değişiklik, bu dokümanda yazan bir kuralı, mimariyi, endpoint'i, ayar şemasını veya konvansiyonu değiştiriyorsa, **önce veya hemen sonra** doküman da düzeltilmelidir.
- Eksik, yanlış veya eski kalan bilgi bulunursa, proje taranmalı ve doğru haliyle değiştirilmelidir. Sadece kodu değiştirip dokümanı unutmak yasaktır.
- Yeni bir konvansiyon, güvenlik kuralı veya kritik davranış ortaya çıkarsa, bu dosyaya açıkça eklenmelidir.
- Bu dosya, sonraki ajanlar (ve insan katkıcılar) için tek kaynak doğru (single source of truth) kabul edilir; dolayısıyla her tutarsızlık derhal giderilmelidir.
- **Her ajan, yaptığı her değişiklikten sonra bu dosyayı güncellemeli VE güncellenmiş değişiklik özetini kullanıcıya göstermelidir (örneğin: "AGENTS.md güncellendi: yeni bölüm X, değişen kısım Y").** Kullanıcı görmeden commit atmak yasaktır.
- _Eğer bir ajan bu kuralı ihlal ederse, sonraki ajanlar ihmal edilen güncellemeleri fark etmeli ve düzeltmelidir._

Bu kural, bu dokümanın son bölümünde tekrar vurgulanmıştır.

---

## 1. Proje Nedir ve Ne Amaçla Kuruldu?

(Proje açıklaması — kullanıcı dolduracak)

---

## 2. Teknoloji Yığını (Tech Stack)

| Teknoloji | Kullanım |
|-----------|----------|
| ... | ... |

---

## 3. Proje Yapısı (Klasör Düzeni)

```
(PROJE_YAPISI)
```

---

## 4. Çalışma Akışı (Development Workflow)

### 4.1. Geliştirme Ortamını Başlatma

```powershell
# Komutlar
```

### 4.2. Test Çalıştırma

```powershell
npm test
```

---

## 5. Mimari ve Önemli Bileşenler

(Mimari açıklaması)

---

## 6. Kod Konvansiyonları ve Stil

### 6.1. Genel Kurallar

- **TypeScript strict mod** açık. `noUnusedLocals`, `noUnusedParameters` etkin. Kullanılmayan import/değişken derleme hatası verir.
- **ES Modules** kullanılır.
- **İngilizce değişken/tip/fonksiyon isimleri**: Türkçe kullanıcı mesajları olabilir ama kod İngilizce.
- **Hata mesajları**: Projeye göre Türkçe veya İngilizce olabilir; mevcut kodda ne kullanılıyorsa ona uy.

### 6.2. Projeye Özel Konvansiyonlar

(Projeye özel kurallar — framework, import, stil vb.)

---

## 7. Kritik Güvenlik ve Gizlilik Kuralları

> Bu bölüm **kesinlikle** dikkate alınmalıdır.

1. **API anahtarları, şifreler ve secret'lar asla frontend'e veya public dosyalara gitmez.**
2. **`.env`, `settings.json`, `db.json` ve secret içeren dosyalar commitlenmez.** `.gitignore` ile korunur. **Asla** bu dosyalara gerçek API anahtarı yazıp commit yapmayın. Eğer yanlışlıkla yapılırsa kullanıcıya hemen bildirin.
3. **`.env` dosyaları gitignore'dadır.** Varsa `.env.example` commit edilebilir, `.env` asla.
4. Yeni bir dış servis entegrasyonu eklenirken API anahtarları her zaman sunucu tarafında kalmalı, istemciye sadece masked/gizli formda gitmelidir.

---

## 8. Sık Karşılaşılacak Değişiklik Senaryoları

(Projeye özel senaryolar ve adımları)

---

## 9. Test ve Doğrulama

Her kod değişikliğinden sonra şunlar çalıştırılmalıdır:

```powershell
# Projeye göre build/test/lint komutları
```

Eğer testler mevcut değilse veya değişiklik yeni bir modül etkiliyorsa, mevcut test dosyalarına uygun şekilde yeni testler eklenmelidir.

---

## 10. Ortak Hatalar ve Çözümleri

| Hata | Olası Neden | Çözüm |
|------|-------------|-------|
| ... | ... | ... |

---

## 11. İletişim ve Referanslar

- **README**: `README.md`
- **Bu dosyayı güncelle**: Eğer proje yapısı, teknoloji yığını veya kritik kurallar değişirse bu `AGENTS.md` dosyasını da güncelleyin. Ayrıntılı kural için 0. bölüme bakın.

---

## 12. Son Not

Kod değişikliği yaparken:

- **Minimal değişiklik** yapın.
- **Mevcut konvansiyonları** takip edin.
- **Testleri çalıştırın**.
- **API anahtarlarını ve kişisel ayarları asla commit etmeyin**.
- **Ve en önemlisi**: her değişiklikten sonra bu `AGENTS.md` dosyasını da gözden geçirin; eski, eksik veya çelişkili bilgi bırakmayın.
- **Kullanıcıya değişiklik özetini gösterin**: `AGENTS.md` güncellendikten sonra değişiklikleri kullanıcıya gösterin, ardından commit ve push yapın.
