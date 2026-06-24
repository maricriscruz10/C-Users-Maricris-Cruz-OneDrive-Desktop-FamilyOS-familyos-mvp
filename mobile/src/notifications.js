// Push + local notifications.
// MVP NOTE: real push delivery requires the Expo Push API (and ultimately
// FCM/APNs credentials) which this sandbox cannot provision. We register the
// device's Expo push token with the backend (POST /api/auth/push-token) so
// the wiring is production-ready, and additionally schedule LOCAL
// notifications client-side for event reminders so reminder behavior is
// fully testable today without a push server.
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { Api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotifications() {
  if (!Device.isDevice) return null; // simulators can't receive real push tokens
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'default', importance: Notifications.AndroidImportance.DEFAULT });
  }
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync();
    await Api.registerPushToken(tokenData.data).catch(() => {});
    return tokenData.data;
  } catch {
    return null;
  }
}

// Schedules a local reminder N minutes before an event's start time.
export async function scheduleEventReminder(event, minutesBefore = 60) {
  const trigger = new Date(new Date(event.startAt).getTime() - minutesBefore * 60000);
  if (trigger <= new Date()) return null;
  return Notifications.scheduleNotificationAsync({
    content: { title: `Upcoming: ${event.title}`, body: `Starts in ${minutesBefore} minutes${event.location ? ' at ' + event.location : ''}` },
    trigger,
  });
}
