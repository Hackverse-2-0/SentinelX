/*
 ╔══════════════════════════════════════════════════════════╗
 ║          EcoSentinel — ESP32 Firmware v2.0.0             ║
 ║   Sensors: DHT22 (Temp+Humidity), MQ135 (CO₂), Moisture ║
 ║   NEW v2: Buzzer Alerts + Dashboard Button Control       ║
 ║   Protocol: MQTT over WiFi → HiveMQ Public Broker        ║
 ╚══════════════════════════════════════════════════════════╝

 REQUIRED LIBRARIES (install via Arduino Library Manager):
   1. PubSubClient   by Nick O'Leary
   2. DHT sensor library  by Adafruit
   3. Adafruit Unified Sensor  by Adafruit

 WIRING GUIDE:
 ┌─────────────────────────────────────────────────────┐
 │  DHT22 Sensor                                       │
 │    VCC  →  3.3V                                     │
 │    GND  →  GND                                      │
 │    DATA →  GPIO 4   (change DHT_PIN below)          │
 │    (put 10kΩ pull-up resistor between VCC & DATA)   │
 ├─────────────────────────────────────────────────────┤
 │  MQ135 Gas Sensor                                   │
 │    VCC  →  5V  (needs 5V for heater!)               │
 │    GND  →  GND                                      │
 │    AO   →  GPIO 34  (Analog Out)                    │
 ├─────────────────────────────────────────────────────┤
 │  Capacitive Moisture Sensor                         │
 │    VCC  →  3.3V                                     │
 │    GND  →  GND                                      │
 │    AO   →  GPIO 35                                  │
 ├─────────────────────────────────────────────────────┤
 │  Passive Buzzer (NEW v2)                            │
 │    +    →  GPIO 26 (BUZZER_PIN)                     │
 │    -    →  GND                                      │
 ├─────────────────────────────────────────────────────┤
 │  Relay Module (optional, NEW v2)                    │
 │    IN   →  GPIO 27 (RELAY_PIN)                      │
 │    VCC  →  5V                                       │
 │    GND  →  GND                                      │
 └─────────────────────────────────────────────────────┘

 NEW COMMAND TOPICS (dashboard → ESP32):
   {prefix}/cmd/buzzer    → "on" | "off" | "beep"
   {prefix}/cmd/relay     → "on" | "off"
   {prefix}/cmd/interval  → e.g. "1000"  (ms, 500–60000)
   {prefix}/cmd/reset     → "1"
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>

// ══════════════════════════════════════════
//   ★  CONFIGURE THESE SETTINGS  ★
// ══════════════════════════════════════════
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* MQTT_BROKER    = "broker.hivemq.com";
const int   MQTT_PORT      = 1883;
const char* MQTT_CLIENT_ID = "eco-node-001";
const char* TOPIC_PREFIX   = "ecosentinel/node1";

// --- Sensor Pins ---
#define DHT_PIN    4
#define DHT_TYPE   DHT22
#define MQ135_PIN  34
#define MOIST_PIN  35

// --- Output Pins ---
#define BUZZER_PIN 26
#define RELAY_PIN  27

// --- Publish interval (ms) ---
uint32_t PUBLISH_INTERVAL = 2000;

// ══════════════════════════════════════════
//   ALERT THRESHOLDS (auto-buzzer)
// ══════════════════════════════════════════
#define ALERT_TEMP_HIGH  75.0f
#define ALERT_CO2_HIGH  1500.0f
#define ALERT_MOIST_LOW   20.0f

// ══════════════════════════════════════════
//   CALIBRATION
// ══════════════════════════════════════════
#define MQ135_RAW_MIN 200
#define MQ135_RAW_MAX 3000
#define MQ135_PPM_MIN 400
#define MQ135_PPM_MAX 2000
#define MOIST_DRY 2800
#define MOIST_WET 1200

// ══════════════════════════════════════════
//   INTERNAL
// ══════════════════════════════════════════
DHT dht(DHT_PIN, DHT_TYPE);
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long lastPublish          = 0;
unsigned long lastReconnectAttempt = 0;
unsigned long buzzerOffTime        = 0;
int  failCount   = 0;
bool buzzerActive = false;
bool relayState   = false;

char topicBuf[80];
const char* makeTopic(const char* suffix) {
  snprintf(topicBuf, sizeof(topicBuf), "%s/%s", TOPIC_PREFIX, suffix);
  return topicBuf;
}

// ──────────────────────────────────────────
// BUZZER HELPERS
// ──────────────────────────────────────────
void buzzerBeep(uint16_t freq, uint32_t durationMs) {
  ledcAttachPin(BUZZER_PIN, 0);
  ledcSetup(0, freq, 8);
  ledcWrite(0, 128);
  buzzerOffTime = millis() + durationMs;
  buzzerActive  = true;
}
void buzzerOff() {
  ledcWrite(0, 0);
  ledcDetachPin(BUZZER_PIN);
  digitalWrite(BUZZER_PIN, LOW);
  buzzerActive = false;
}
void buzzerAlert(const char* level) {
  if      (strcmp(level, "critical") == 0) buzzerBeep(2000, 3000);
  else if (strcmp(level, "warning")  == 0) buzzerBeep(1200, 1000);
  else                                     buzzerBeep(800,  400);
}

// ──────────────────────────────────────────
// MQTT CALLBACK
// ──────────────────────────────────────────
void mqttCallback(char* rawTopic, byte* payload, unsigned int length) {
  char msg[64] = {0};
  strncpy(msg, (char*)payload, min((unsigned int)63, length));

  Serial.print(F("[CMD] ")); Serial.print(rawTopic);
  Serial.print(F(" = ")); Serial.println(msg);

  char cmpBuf[80];

  snprintf(cmpBuf, sizeof(cmpBuf), "%s/cmd/buzzer", TOPIC_PREFIX);
  if (strcmp(rawTopic, cmpBuf) == 0) {
    if      (strcmp(msg, "on")   == 0) buzzerBeep(1500, 30000);
    else if (strcmp(msg, "off")  == 0) buzzerOff();
    else if (strcmp(msg, "beep") == 0) buzzerBeep(1200, 400);
    return;
  }

  snprintf(cmpBuf, sizeof(cmpBuf), "%s/cmd/relay", TOPIC_PREFIX);
  if (strcmp(rawTopic, cmpBuf) == 0) {
    relayState = (strcmp(msg, "on") == 0);
    digitalWrite(RELAY_PIN, relayState ? HIGH : LOW);
    mqtt.publish(makeTopic("relay/state"), relayState ? "on" : "off", true);
    return;
  }

  snprintf(cmpBuf, sizeof(cmpBuf), "%s/cmd/interval", TOPIC_PREFIX);
  if (strcmp(rawTopic, cmpBuf) == 0) {
    uint32_t v = atoi(msg);
    if (v >= 500 && v <= 60000) { PUBLISH_INTERVAL = v; Serial.print(F("[CMD] Interval=")); Serial.println(v); }
    return;
  }

  snprintf(cmpBuf, sizeof(cmpBuf), "%s/cmd/reset", TOPIC_PREFIX);
  if (strcmp(rawTopic, cmpBuf) == 0 && strcmp(msg, "1") == 0) {
    Serial.println(F("[CMD] Remote reset!"));
    delay(500); ESP.restart();
  }
}

// ──────────────────────────────────────────
// SETUP
// ──────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n[ EcoSentinel ESP32 v2.0.0 ]"));

  dht.begin();
  analogReadResolution(12);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(RELAY_PIN, LOW);

  buzzerBeep(1000, 150);   // startup tone
  connectWiFi();
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setKeepAlive(60);
  mqtt.setBufferSize(256);
}

// ──────────────────────────────────────────
// MAIN LOOP
// ──────────────────────────────────────────
void loop() {
  if (buzzerActive && millis() >= buzzerOffTime) buzzerOff();

  if (WiFi.status() != WL_CONNECTED) connectWiFi();

  if (!mqtt.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 5000) { lastReconnectAttempt = now; connectMQTT(); }
  } else {
    mqtt.loop();
  }

  if (millis() - lastPublish >= PUBLISH_INTERVAL) {
    lastPublish = millis();
    readAndPublish();
  }
}

// ──────────────────────────────────────────
// WIFI
// ──────────────────────────────────────────
void connectWiFi() {
  Serial.print(F("[WiFi] Connecting to ")); Serial.print(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) { delay(500); Serial.print('.'); attempts++; }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(F("\n[WiFi] OK")); Serial.println(WiFi.localIP());
  } else { Serial.println(F("\n[WiFi] FAILED — restarting")); delay(5000); ESP.restart(); }
}

// ──────────────────────────────────────────
// MQTT
// ──────────────────────────────────────────
void connectMQTT() {
  char willTopic[80];
  snprintf(willTopic, sizeof(willTopic), "%s/status", TOPIC_PREFIX);
  if (mqtt.connect(MQTT_CLIENT_ID, NULL, NULL, willTopic, 0, true, "offline")) {
    Serial.println(F("[MQTT] Connected"));
    mqtt.publish(willTopic, "online", true);
    failCount = 0;
    char subTopic[80];
    snprintf(subTopic, sizeof(subTopic), "%s/cmd/#", TOPIC_PREFIX);
    mqtt.subscribe(subTopic);
    Serial.print(F("[MQTT] Subscribed: ")); Serial.println(subTopic);
  } else {
    failCount++;
    Serial.print(F("[MQTT] Failed rc=")); Serial.println(mqtt.state());
    if (failCount > 10) ESP.restart();
  }
}

// ──────────────────────────────────────────
// READ & PUBLISH
// ──────────────────────────────────────────
void readAndPublish() {
  if (!mqtt.connected()) return;
  char payload[16];
  bool triggerAlert = false;
  char alertLevel[12] = "warning";

  float temp = dht.readTemperature();
  if (!isnan(temp)) {
    snprintf(payload, sizeof(payload), "%.1f", temp);
    mqtt.publish(makeTopic("temperature"), payload);
    Serial.print(F("[T] ")); Serial.println(temp);
    if (temp > ALERT_TEMP_HIGH) { triggerAlert = true; strcpy(alertLevel, "critical"); }
  }

  float hum = dht.readHumidity();
  if (!isnan(hum)) {
    snprintf(payload, sizeof(payload), "%.1f", hum);
    mqtt.publish(makeTopic("humidity"), payload);
    Serial.print(F("[H] ")); Serial.println(hum);
  }

  float ppm = constrain(
    mapFloat(analogRead(MQ135_PIN), MQ135_RAW_MIN, MQ135_RAW_MAX, MQ135_PPM_MIN, MQ135_PPM_MAX),
    MQ135_PPM_MIN, MQ135_PPM_MAX);
  snprintf(payload, sizeof(payload), "%.0f", ppm);
  mqtt.publish(makeTopic("co2"), payload);
  Serial.print(F("[C] ")); Serial.println(ppm);
  if (ppm > ALERT_CO2_HIGH && !triggerAlert) { triggerAlert = true; strcpy(alertLevel, "critical"); }

  float moist = constrain(
    mapFloat(analogRead(MOIST_PIN), MOIST_DRY, MOIST_WET, 0.0f, 100.0f), 0.0f, 100.0f);
  snprintf(payload, sizeof(payload), "%.1f", moist);
  mqtt.publish(makeTopic("moisture"), payload);
  Serial.print(F("[M] ")); Serial.println(moist);
  if (moist < ALERT_MOIST_LOW && !triggerAlert) { triggerAlert = true; strcpy(alertLevel, "warning"); }

  mqtt.publish(makeTopic("relay/state"), relayState ? "on" : "off", true);

  if (triggerAlert && !buzzerActive) {
    buzzerAlert(alertLevel);
    mqtt.publish(makeTopic("alert/triggered"), alertLevel);
    Serial.print(F("[ALERT] ")); Serial.println(alertLevel);
  }
  Serial.println(F("----"));
}

float mapFloat(float x, float in_min, float in_max, float out_min, float out_max) {
  if (in_max == in_min) return out_min;
  return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}
