# চ্যাট কল চালু করা: কী লাগে, কীভাবে করা হয়েছে

এই ফাইলে CredenceHR-এর চ্যাট কল (অডিও/ভিডিও) চালু করতে যা যা লেগেছে আর যেভাবে করা হয়েছে, সব লেখা আছে। কোনো password এখানে নেই। TURN-এর password শুধু VM-এর `/etc/turnserver.conf` আর লাইভ `.env`-এ থাকে।

---

## ০. এখনকার অবস্থা (কাজ আপাতত থামানো, পরে আবার ধরা হবে)

### কল কোথায় চলছে

| কে কাকে কল দিচ্ছে | ফল | কারণ |
|---|---|---|
| অফিস network ↔ অফিস network | ✅ জোড়ে | দুই ফোন সরাসরি একে অপরকে পায়, TURN লাগে না |
| অফিস network ↔ মোবাইল ডেটা | ✅ জোড়ে (মাঝে মাঝে ব্যর্থ হতে পারে) | অফিসের ফোন coturn-কে LAN দিয়ে (`192.168.66.5`) পায়, তাই অফিসের দিকের relay ঠিকমতো কাজ করে |
| মোবাইল ডেটা ↔ মোবাইল ডেটা | ❌ জোড়ে না | দুজনকেই বাইরে থেকে relay নিতে হয়। ঢোকে `203.95.222.58` দিয়ে, কিন্তু coturn-এর উত্তর বের হয় `103.60.175.34` দিয়ে, তাই ফোন উত্তরটা ফেলে দেয় (৫ নম্বর অংশ দেখুন) |

### যা হয়ে গেছে ✅

- [x] কোড: CallLayer-এ ২৫ সেকেন্ডের timeout, TURN না থাকলে আলাদা বার্তা, সার্ভার চালু হওয়ার সময় TURN-এর সতর্কবার্তা
- [x] কোড: অ্যাপের লাইভ ঠিকানা `https://hr.credencegroupbd.com` (capacitor.config, Android/iOS workflow)
- [x] কোড: `.env` সবার আগে লোড হয়, তাই `CORS_ORIGINS` এখন সত্যিই কাজ করে
- [x] কোড: MySQL বন্ধ হলেও সার্ভার আর crash করে না; `DB_REQUIRED=true` থাকলে MySQL না পাওয়া পর্যন্ত অপেক্ষা করে
- [x] Hyper-V install, অফিস LAN card-এ external switch, vEthernet = `192.168.66.4`
- [x] Ubuntu VM `192.168.66.5`, SSH (`ssh credence@192.168.66.5`)
- [x] coturn install আর config (port 3478, relay 40000–40039, `external-ip=203.95.222.58/192.168.66.5`, realm `hr.credencegroupbd.com`)
- [x] VM firewall (ufw): OpenSSH, 3478 UDP/TCP, 40000–40039 UDP
- [x] Windows Firewall-এ 3478 UDP/TCP আর 40000–40039 UDP খোলা
- [x] Windows RRAS NAT: Ethernet 2 public (basic firewall ছাড়া), vEthernet private, Services and Ports-এ নিয়ম
- [x] Trickle ICE: অফিসের ভেতর থেকে relay এসেছে। 401 ঠিক করা হয়েছে (username `credencehr`)
- [x] লাইভ `.env`: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, Cloudflare-এর দুই লাইন ফাঁকা, `DB_REQUIRED=true`, `CORS_ORIGINS`
- [x] Windows route metric বদলে দেখা হয়েছিল, তাতে site বন্ধ হয়ে যায়। আবার `metric=0` করে ফেরানো হয়েছে, site চলছে

### যা বাকি আছে ⏳

1. **মোবাইল ডেটা ↔ মোবাইল ডেটা কল (মূল কাজ):** বাইরে থেকে coturn-এ আসার পথ আর ফেরার পথ এক করতে হবে। নিচের তিনটা পথের একটা বেছে নিতে হবে (বিস্তারিত ৫ নম্বর অংশে):
   - **ক. Cloudflare TURN:** লাইভ `.env`-এ `CLOUDFLARE_TURN_KEY_ID` আর `CLOUDFLARE_TURN_API_TOKEN` দিয়ে restart। সবচেয়ে দ্রুত। Cloudflare dashboard → Realtime/Calls → TURN → Create key।
   - **খ. অফিস router-এ port forward:** 3478 UDP/TCP আর 40000–40039 UDP → `192.168.66.5`। আগে জেনে নিতে হবে `103.60.175.34` static IP কিনা, router কে চালান, আর অফিসে দুটো লাইন আছে কিনা (`103.60.175.41`, `202.134.11.253`-ও দেখা গেছে)।
   - **গ. ISP থেকে /29 বা বাড়তি public IP:** VM সরাসরি public লাইনে বসবে।
2. খ বা ক বেছে নিলে **Windows NAT বন্ধ** করতে হবে (Disable Routing and Remote Access), আর VM-এর gateway `192.168.66.1` আছে কিনা মিলিয়ে নিতে হবে।
3. **নতুন APK build করে ফোনে বসানো:** `https://hr.credencegroupbd.com` থেকে খোলে এমন APK। পুরনো http-IP APK-তে কল কখনো চলবে না।
4. **শেষ পরীক্ষা:** মোবাইল ডেটা ↔ মোবাইল ডেটা, মোবাইল ডেটা ↔ অফিস, আর আলাদা দুই অপারেটর (যেমন GP ↔ Robi)। কল ২–৩ মিনিট চালিয়ে দেখতে হবে কেটে যায় কিনা।
5. **ঐচ্ছিক:** TURN password বদলানো (screenshot-এ দেখা গিয়েছিল)। পরে `use-auth-secret` দিয়ে প্রতিবার অস্থায়ী password দেওয়ার ব্যবস্থা।
6. **অন্য network সংক্রান্ত:** MySQL কেন বন্ধ হয়েছিল তা Laragon-এর MySQL log-এ দেখা। VM-এর RAM 1 GB আর Dynamic Memory চালু করা। Laragon-এ "Start All Automatically" চালু করা।

### আবার কাজ ধরার সময় প্রথমে যা চালাবেন

```bash
# VM-এ (ssh credence@192.168.66.5)
sudo systemctl status coturn --no-pager
ip route | grep default          # gateway কোনটা (.1 না .4) দেখে নিন
curl -s ifconfig.me; echo         # VM কোন IP দিয়ে বের হয় (আগে ছিল 103.60.175.34)
```

---

## ১. সমস্যা কী ছিল

HTTPS চালু করার পর মোবাইল থেকে কল দিলে অপর পাশে **"Connecting…"**-এ আটকে থাকত, কল আর জুড়ত না। এর পেছনে তিনটা আলাদা কারণ ছিল:

| # | কারণ | ফল |
|---|---|---|
| ১ | কল দুই ফোনের মধ্যে সরাসরি (WebRTC) যায়। মোবাইল ডেটা বা আলাদা Wi-Fi হলে সরাসরি পথ পাওয়া যায় না, মাঝে একটা **TURN relay server** লাগে। আগে কোনো TURN ছিল না, শুধু STUN ছিল। | একই Wi-Fi-তে কল চলত, বাইরে চলত না |
| ২ | Android অ্যাপ (APK) খুলত `http://203.95.222.58:3000` (http, IP) থেকে। Browser http পাতায় মাইক্রোফোন দেয় না। | "Calls need the secure (https://) address" বার্তা আসত |
| ৩ | অ্যাপের config-এ পুরনো domain `hr.credencehousinglimited.com` লেখা ছিল | APK সঠিক https ঠিকানায় যেত না |

---

## ২. কোডে যা বদলানো হয়েছে

| ফাইল | কী করা হয়েছে |
|---|---|
| `src/components/CallLayer.tsx` | ২৫ সেকেন্ডে না জুড়লে কল নিজে থেকেই শেষ হয়ে কারণ দেখায় (`CONNECT_TIMEOUT_MS`), আর "Connecting…"-এ আটকে থাকে না। TURN না থাকলে আলাদা বার্তা দেখায় (`failed-no-turn`)। `connectionstate` আর `iceconnectionstate` দুটোই দেখা হয়। |
| `CallRoutes.ts` | সার্ভার চালু হওয়ার সময় TURN সেট না থাকলে সতর্কবার্তা দেখায়। ফোনকে TURN-এর ঠিকানা আর username/password এখান থেকেই দেওয়া হয়। |
| `capacitor.config.ts` | লাইভ ঠিকানা `https://hr.credencegroupbd.com` করা হয়েছে |
| `.github/workflows/android.yml`, `ios.yml` | Cloud build-এর ডিফল্ট `CAP_SERVER_URL` এখন `https://hr.credencegroupbd.com` |
| `server.ts` | `.env` এখন সবার আগে লোড হয় (`import "dotenv/config"`)। আগে `CORS_ORIGINS`-এর মতো কিছু মান কাজ করত না। |
| `WebSecurity.ts` | `CORS_ORIGINS` তালিকা এখন `.env` লোড হওয়ার পরে পড়া হয় |
| `.env.example` | TURN-এর ব্যাখ্যা দেওয়া আছে |

### সার্ভার কোন TURN ব্যবহার করবে

1. `CLOUDFLARE_TURN_KEY_ID` আর `CLOUDFLARE_TURN_API_TOKEN` দুটোই ভরা থাকলে **Cloudflare TURN** ব্যবহার হয়। এটা আগে দেখা হয়।
2. না থাকলে `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` দিয়ে **নিজের coturn** ব্যবহার হয়।
3. কোনোটাই না থাকলে শুধু STUN চলে। তখন শুধু একই network-এ কল জুড়বে।

তাই নিজের coturn ব্যবহার করলে Cloudflare-এর দুই লাইন **ফাঁকা** রাখতে হবে।

---

## ৩. Network-এর ছবি (লাইভ server)

```
                    Internet
                       │
         ┌─────────────┴──────────────┐
         │ Ethernet 2 (public)        │  203.95.222.58  ← domain hr.credencegroupbd.com এখানে আসে
         │ Windows Server 2022        │
         │ (Laragon, CredenceHR :3000)│
         │ vEthernet (LAN)            │  192.168.66.4   (Hyper-V external switch, অফিস LAN card-এ)
         └─────────────┬──────────────┘
                       │  অফিস LAN 192.168.66.0/24, router 192.168.66.1
                       │  (অফিস router-এর নিজের internet: 103.60.175.34)
         ┌─────────────┴──────────────┐
         │ Hyper-V VM: Ubuntu Server  │  192.168.66.5
         │ coturn  :3478 udp/tcp      │
         │ relay   :40000–40039 udp   │
         └────────────────────────────┘
```

| জিনিস | মান |
|---|---|
| Public IP (Windows, Ethernet 2) | `203.95.222.58` |
| Windows-এর LAN IP (vEthernet) | `192.168.66.4` |
| coturn VM | `192.168.66.5` (Ubuntu, Hyper-V) |
| অফিস router / gateway | `192.168.66.1` |
| TURN port | 3478 (UDP + TCP) |
| Relay port | 40000–40039 (UDP) |
| TURN username | `credencehr` |
| realm | `hr.credencegroupbd.com` |

---

## ৪. ধাপে ধাপে যা করা হয়েছে

### ধাপ ১: Hyper-V install আর virtual switch

1. Server Manager → Add Roles and Features → **Hyper-V**। Migration-এ কিছু টিক দেওয়া হয়নি, default store রাখা হয়েছে।
2. Virtual Switch Manager → **External network** তৈরি করা হয়েছে। card হিসেবে বাছা হয়েছে **অফিস LAN-এর card** ("Realtek PCIe GbE Family Controller", নামে "#2" নেই), public card **না**। "Allow management operating system to share" টিক দেওয়া।
3. Switch বানানোর পর Windows LAN IP-টা নিজে থেকে সরায়নি, তাই হাতে দেওয়া হয়েছে:
   - **vEthernet (LAN)** → IPv4: IP `192.168.66.4`, mask `255.255.255.0`, gateway `192.168.66.1`, DNS `103.60.172.20`, `8.8.8.8`
   - পুরনো physical **Ethernet** adapter-এ এখন কোনো IP থাকবে না (শুধু virtual switch binding)। এটাই ঠিক।
4. যাচাই: `ipconfig`-এ vEthernet = `192.168.66.4`, Ethernet 2 = `203.95.222.58`। `ping 192.168.66.1`-এ উত্তর আসে।

> **শেখা ভুল:** প্রথমবার switch public card-এ বসানো হয়েছিল। তখন public লাইন `169.254…` পেয়ে site বন্ধ হয়ে গিয়েছিল। আবার, VM-এর IP (`.5`) ভুল করে vEthernet-এ বসানো হয়েছিল। vEthernet সবসময় `.4`, VM `.5`।

### ধাপ ২: Ubuntu VM

1. Hyper-V Manager → New Virtual Machine। Generation 2, network = ওপরের LAN switch, Ubuntu Server ISO দিয়ে।
2. Install-এর সময় network: `eth0` → Edit IPv4 → **Manual**
   - Subnet `192.168.66.0/24`, Address `192.168.66.5`, Gateway `192.168.66.1`, DNS `103.60.172.20,8.8.8.8`
3. OpenSSH server install করা হয়েছে। Windows থেকে `ssh credence@192.168.66.5`।
4. RAM: coturn-এর জন্য 1 GB যথেষ্ট। Dynamic Memory চালু রাখুন, যাতে Windows/MySQL-এর RAM কম না পড়ে।

### ধাপ ৩: coturn install আর config (VM-এ)

```bash
sudo apt update && sudo apt install -y coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
PASS=$(openssl rand -hex 16); echo $PASS      # এটাই TURN password, লিখে রাখুন
```

`/etc/turnserver.conf` (password-এর জায়গায় আসলটা বসবে):

```
listening-port=3478
listening-ip=192.168.66.5
relay-ip=192.168.66.5
external-ip=203.95.222.58/192.168.66.5
min-port=40000
max-port=40039
fingerprint
lt-cred-mech
user=credencehr:<PASSWORD>
realm=hr.credencegroupbd.com
no-tls
no-dtls
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
syslog
```

- `external-ip=<public>/<private>`: coturn বাইরের ফোনকে public ঠিকানাটা জানায়।
- `realm` শুধু একটা পরিচয়-নাম, কলের কাজে কোনো প্রভাব ফেলে না।
- `no-tls`: 5349 (turns:) চালু নেই। এর জন্য certificate লাগত। 3478 UDP/TCP যথেষ্ট।

চালু করা আর VM-এর firewall:

```bash
sudo systemctl enable --now coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager        # active (running)
sudo ss -lnup | grep 3478

sudo ufw allow OpenSSH                          # এটা আগে দিতে হবে, নইলে SSH কেটে যাবে
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 40000:40039/udp
sudo ufw --force enable
sudo ufw status
```

### ধাপ ৪: অফিসের ভেতর থেকে পরীক্ষা

Browser-এ খুলুন: <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>

- URI `turn:192.168.66.5:3478`, username `credencehr`, password VM-এর password দিয়ে **Gather candidates** চাপুন।
- **Type = relay** এলে coturn ঠিক আছে।
- **401 Unauthorized** এলে username বা password ভুল। একবার এভাবেই হয়েছিল: username `credence` দেওয়া হয়েছিল, ঠিকটা `credencehr`।

### ধাপ ৫: Windows Firewall (cmd, Administrator হিসেবে)

```
netsh advfirewall firewall add rule name="TURN 3478 UDP" dir=in action=allow protocol=UDP localport=3478
netsh advfirewall firewall add rule name="TURN 3478 TCP" dir=in action=allow protocol=TCP localport=3478
netsh advfirewall firewall add rule name="TURN relay UDP" dir=in action=allow protocol=UDP localport=40000-40039
netsh advfirewall firewall show rule name=all dir=in | findstr /i "TURN"
```

(এই server-এ PowerShell চলে না, তাই `netsh` ব্যবহার করা হয়েছে।)

### ধাপ ৬: Windows-এ NAT (Routing and Remote Access)

বাইরের ফোন `203.95.222.58:3478`-এ এলে সেটা পৌঁছায় Windows-এ। Windows NAT সেটা VM (`192.168.66.5`)-এ পাঠায়।

1. Server Manager → Add Roles and Features → **Remote Access** → Role Services-এ শুধু **Routing** (DirectAccess and VPN নিজে থেকে যোগ হয়)। **Remote Desktop Services বা IIS টিক দেবেন না।** IIS ভুল করে এসে গেলে `W3SVC` service বন্ধ রাখুন, নইলে 80/443 নিয়ে Laragon-এর সাথে ঝামেলা হতে পারে।
2. Tools → **Routing and Remote Access** → server-এ right-click → Configure and Enable → **Custom configuration → NAT** → Finish → Start service।
3. IPv4 → NAT → **New Interface**:
   - **Ethernet 2** → *Public interface connected to the Internet* → ✅ Enable NAT → ❌ **"Enable a basic firewall" টিক দেবেন না** (দিলে site বন্ধ হয়ে যায়)
   - **vEthernet** → *Private interface connected to private network*
4. **Ethernet 2** → Properties → **Services and Ports** → Add। প্রতিটা port আলাদা নিয়ম:

| Protocol | Incoming port | Private address | Outgoing port |
|---|---|---|---|
| UDP | 3478 | 192.168.66.5 | 3478 |
| TCP | 3478 | 192.168.66.5 | 3478 |
| UDP | 40000 … 40039 (প্রতিটা আলাদা) | 192.168.66.5 | একই নম্বর |

5. NAT চালুর সাথে সাথে মোবাইল ডেটা থেকে `https://hr.credencegroupbd.com` খুলে দেখা হয়েছে site চলছে।

**ফেরত যাওয়ার পথ:** server-এ right-click → **Disable Routing and Remote Access**।

### ধাপ ৭: বাইরে থেকে পরীক্ষা

মোবাইল ডেটার hotspot থেকে Trickle ICE-এ URI `turn:hr.credencegroupbd.com:3478` দিয়ে দেখা হয়েছে। **relay, `203.95.222.58`** এসেছে, মানে বাইরে থেকে coturn-এ পৌঁছানো যাচ্ছে।

### ধাপ ৮: লাইভ CredenceHR-এর `.env`

```
CLOUDFLARE_TURN_KEY_ID=""
CLOUDFLARE_TURN_API_TOKEN=""
TURN_URLS="turn:hr.credencegroupbd.com:3478?transport=udp,turn:hr.credencegroupbd.com:3478?transport=tcp"
TURN_USERNAME="credencehr"
TURN_CREDENTIAL="<VM-এর TURN password>"

DB_REQUIRED=true
CORS_ORIGINS="https://hr.credencegroupbd.com,http://203.95.222.58:3000"
```

- `nslookup hr.credencegroupbd.com` = `203.95.222.58`, মাঝে কোনো proxy নেই। তাই domain দেওয়া যায়। Cloudflare-এর মতো proxy থাকলে সরাসরি IP দিতে হতো।
- LAN IP বা `localhost` দিয়ে কেউ app খুললে সেই ঠিকানাও `CORS_ORIGINS`-এ দিন, নইলে চ্যাট আর কলের real-time সংযোগ বন্ধ থাকবে।
- `.env` বদলানোর পর CredenceHR restart দিন।

### ধাপ ৯: মোবাইল অ্যাপ (APK) https-এ

- `capacitor.config.ts`-এ `USE_REAL_SERVER = true`, `USE_IP_INSTEAD_OF_DOMAIN = false`। অথবা GitHub Actions-এর Android build, যার ডিফল্ট এখন `https://hr.credencegroupbd.com`।
- নিজের PC থেকে build করলে: `npm run build` → `npx cap sync android` → Android Studio থেকে APK।
- http IP (`http://203.95.222.58:3000`) থেকে খোলা অ্যাপে কল **কখনো** চলবে না, কারণ মাইক্রোফোন পাওয়া যায় না।

---

## ৫. এখনো বাকি সমস্যা: বের হওয়ার পথ আলাদা

পরীক্ষায় দেখা গেছে, VM থেকে বাইরে যাওয়া traffic বের হয় **অফিস router `103.60.175.34`** দিয়ে (`curl -s ifconfig.me`)। কিন্তু বাইরের ফোন আসে **`203.95.222.58`** দিয়ে। Relay ঠিকমতো চলতে আসা আর যাওয়া একই public IP দিয়ে হওয়া দরকার। তাই দুই ফোনই বাইরের network-এ থাকলে relay কল জুড়তে নাও পারে।

যা চেষ্টা করা হয়েছিল:
- VM-এর gateway `192.168.66.4` (Windows) করা হয়েছিল। Windows তখন ICMP **Redirect** দিয়ে VM-কে আবার `.1`-এ পাঠিয়ে দিচ্ছিল।
- Windows-এ দুই default route-এর metric সমান (281)। Public লাইনকে আগে রাখতে metric বদলানো হয়েছিল (`netsh interface ipv4 set interface <n> metric=…`), কিন্তু তাতে **site বন্ধ হয়ে যায়**। তাই আবার `metric=0` (automatic) করে ফেরানো হয়েছে।

```
netsh interface ipv4 set interface 5 metric=0
netsh interface ipv4 set interface 20 metric=0
```

**সমাধানের তিনটা পথ (একটা বেছে নিতে হবে):**

| পথ | কী করতে হবে | সুবিধা / অসুবিধা |
|---|---|---|
| ১. অফিস router-এ port forward | Router-এ 3478 UDP/TCP আর 40000–40039 UDP → `192.168.66.5`। VM-এর gateway `192.168.66.1`। coturn-এ `external-ip=103.60.175.34/192.168.66.5`। `TURN_URLS`-এ `turn:103.60.175.34:3478?...` | Windows-এ হাত দিতে হয় না। কিন্তু `103.60.175.34` স্থির (static) IP হতে হবে। অফিসে দুই লাইনও থাকতে পারে, কারণ `103.60.175.41` আর `202.134.11.253`-ও দেখা গেছে। |
| ২. ISP থেকে বাড়তি public IP (/29) | VM-কে সরাসরি public লাইনে নতুন IP দিয়ে বসানো। NAT লাগবে না। | সবচেয়ে পরিষ্কার, তবে মাসিক খরচ লাগে |
| ৩. Cloudflare TURN | `.env`-এ শুধু `CLOUDFLARE_TURN_KEY_ID` আর `CLOUDFLARE_TURN_API_TOKEN` | কোনো network কাজ নেই। কলের metadata Cloudflare দেখবে। |

পথ ১ বা ৩ নিলে Windows NAT আর লাগবে না (Disable Routing and Remote Access)।

---

## ৬. কল কাজ না করলে যা দেখবেন

| লক্ষণ | কারণ / কী দেখবেন |
|---|---|
| "Calls need the secure (https://) address" | অ্যাপ বা পাতা http থেকে খোলা। `https://hr.credencegroupbd.com` থেকে খুলুন বা নতুন APK বানান। |
| ২৫ সেকেন্ড পরে "couldn't connect" (TURN নেই বলে) | `.env`-এ TURN দেওয়া নেই, বা Cloudflare-এর লাইনে পুরনো মান আছে। সার্ভারের চালুর লগ দেখুন। |
| Trickle ICE-এ 401 | username বা password ভুল (`sudo grep user= /etc/turnserver.conf`) |
| Trickle ICE-এ কোনো relay নেই | coturn বন্ধ (`systemctl status coturn`), ufw, Windows Firewall, বা NAT-এর Services and Ports |
| একই Wi-Fi-তে চলে, বাইরে চলে না | ওপরের ৫ নম্বর অংশ (বের হওয়ার পথ আলাদা) |
| চ্যাট মেসেজও লাইভ আসে না | `CORS_ORIGINS`-এ যে ঠিকানা দিয়ে খোলা হয়েছে সেটা নেই |
| পুরো site বন্ধ | NAT-এ "basic firewall" টিক দেওয়া, অথবা metric বদলানো হয়েছে। ওপরের ফেরত যাওয়ার পথ দেখুন। |

দরকারি কমান্ড:

```bash
# VM
sudo systemctl status coturn --no-pager
sudo journalctl -u coturn -n 50 --no-pager
sudo ufw status
curl -s ifconfig.me; echo            # VM কোন IP দিয়ে বাইরে যায়
```

```
:: Windows (cmd)
ipconfig
route print -4
netsh advfirewall firewall show rule name=all dir=in | findstr /i "TURN"
nslookup hr.credencegroupbd.com
```

---

## ৭. নিরাপত্তা

- TURN password এই ফাইলে বা git-এ কোথাও নেই। আছে শুধু VM-এর `/etc/turnserver.conf` আর লাইভ `.env`-এ।
- যে screenshot-এ password দেখা যায়, সেটা কাউকে পাঠাবেন না। সন্দেহ হলে নতুন password বানিয়ে দুই জায়গায় বদলে দিন, তারপর `sudo systemctl restart coturn` আর CredenceHR restart।
- `denied-peer-ip` দিয়ে 10.x আর 172.16–31.x network-এ relay বন্ধ রাখা হয়েছে, যাতে TURN দিয়ে কেউ ভেতরের network-এ ঢুকতে না পারে।
- এখনকার password স্থায়ী, আর কলের সুযোগ থাকা সব user-এর অ্যাপ সেটা পায়। পরে চাইলে coturn-এর `use-auth-secret` দিয়ে প্রতিবার অস্থায়ী password দেওয়ার ব্যবস্থা করা যায়।
