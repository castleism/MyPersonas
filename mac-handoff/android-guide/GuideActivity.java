package com.portfolio.guide;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** Native, accessible walkthrough shared by Android hosts. Content is app-specific. */
public final class GuideActivity extends Activity {
    private JSONObject content;
    private int step, accent;
    private SharedPreferences preferences;
    private LinearLayout body;
    private ScrollView scroll;
    private TextView progress;
    private Button back, next;
    private final int ink=Color.rgb(38,48,43), paper=Color.rgb(249,247,240);

    @Override public void onCreate(Bundle state) {
        setTheme(android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(state);
        preferences=getSharedPreferences(AppGuide.PREFS,0);
        step=state==null?0:state.getInt("step",0);
        try (InputStream in=getAssets().open("app-guide.json")) {
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            byte[] buffer=new byte[4096]; int size;
            while((size=in.read(buffer))!=-1) bytes.write(buffer,0,size);
            content=new JSONObject(bytes.toString("UTF-8"));
            accent=Color.parseColor(content.getString("accent"));
        } catch(Exception error) { finish(); return; }
        Window window=getWindow();
        window.setStatusBarColor(paper); window.setNavigationBarColor(paper);
        window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(paper); root.setPadding(dp(24),dp(16),dp(24),dp(16));
        root.setOnApplyWindowInsetsListener((view,insets)->{
            view.setPadding(dp(24),dp(16)+insets.getSystemWindowInsetTop(),dp(24),dp(16)+insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        LinearLayout header=new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        progress=text("",14,false);progress.setTextColor(accent);
        header.addView(progress,new LinearLayout.LayoutParams(0,-2,1));
        Button skip=button("Skip guide",false);skip.setOnClickListener(v->complete());header.addView(skip);
        root.addView(header);
        scroll=new ScrollView(this);scroll.setFillViewport(false);
        body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(0,dp(24),0,dp(24));
        scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.CENTER_VERTICAL);
        back=button("Back",false);back.setOnClickListener(v->{step--;render();});
        next=button("Next",true);next.setOnClickListener(v->{if(step==3)complete();else{step++;render();}});
        actions.addView(back,new LinearLayout.LayoutParams(0,-2,1));
        LinearLayout.LayoutParams nextParams=new LinearLayout.LayoutParams(0,-2,1);nextParams.leftMargin=dp(12);actions.addView(next,nextParams);
        root.addView(actions);render();
    }
    private void render() {
        body.removeAllViews();progress.setText("APP GUIDE  ·  "+(step+1)+" OF 4");
        int artwork=getResources().getIdentifier("brand_hero","drawable",getPackageName());
        if(artwork!=0) {
            android.widget.ImageView illustration=new android.widget.ImageView(this);
            illustration.setImageResource(artwork);
            illustration.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
            illustration.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            body.addView(illustration,new LinearLayout.LayoutParams(-1,dp(128)));
        }
        back.setVisibility(step==0?View.INVISIBLE:View.VISIBLE);next.setText(step==3?"Open app":"Next");
        String[] titles={"A place for "+content.optString("purpose"),"What you can do","Try this first","Make it yours"};
        TextView brand=text(content.optString("name"),16,false);brand.setTextColor(accent);body.addView(brand);
        TextView title=text(titles[step],34,true);title.setPadding(0,dp(16),0,dp(20));if(android.os.Build.VERSION.SDK_INT>=28)title.setAccessibilityHeading(true);body.addView(title);
        if(step==0) {
            paragraph(content.optString("intro"));
            paragraph("A short tour of this test build. You can skip now and replay it later by long-pressing this app’s icon and choosing App guide.");
        } else if(step==1) {
            items(content.optJSONArray("features"),false);
            TextView boundary=text("WHAT TO EXPECT",13,false);boundary.setTextColor(accent);boundary.setPadding(0,dp(20),0,dp(8));body.addView(boundary);
            paragraph(content.optString("boundary"));
        } else if(step==2) {
            paragraph("EXAMPLE ONLY · This guide does not create or change your records.");
            items(content.optJSONArray("demo"),false);
        } else {
            paragraph("Optional setup checklist. Check off steps after you do them in the app; this guide does not configure them for you.");
            items(content.optJSONArray("setup"),true);
            paragraph(content.optString("privacy"));
            paragraph("Need another look? Long-press the app icon → App guide on a launcher that supports shortcuts. Your checklist stays on this device.");
        }
        scroll.post(()->scroll.scrollTo(0,0));
        title.requestFocus();title.announceForAccessibility(titles[step]);
    }
    private void items(JSONArray entries,boolean checklist) {
        if(entries==null)return;
        for(int i=0;i<entries.length();i++) {
            String label=entries.optString(i);
            if(checklist) {
                final String key="setup_"+i;
                CheckBox box=new CheckBox(this);box.setText(label);box.setTextSize(17);box.setTextColor(ink);box.setMinHeight(dp(56));box.setPadding(0,dp(10),0,dp(10));
                box.setChecked(preferences.getBoolean(key,false));
                box.setOnCheckedChangeListener((view,checked)->preferences.edit().putBoolean(key,checked).apply());body.addView(box);
            } else paragraph((i+1)+".  "+label);
        }
    }
    private TextView text(String value,int size,boolean serif) {
        TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(ink);
        view.setTypeface(serif?Typeface.create("serif",Typeface.NORMAL):Typeface.create("sans-serif",Typeface.NORMAL));
        view.setLineSpacing(dp(4),1);return view;
    }
    private void paragraph(String value) {TextView view=text(value,17,false);view.setPadding(0,0,0,dp(20));body.addView(view);}
    private Button button(String label,boolean primary) {
        Button button=new Button(this);button.setText(label);button.setAllCaps(false);button.setTextSize(16);button.setMinHeight(dp(52));button.setPadding(dp(16),dp(10),dp(16),dp(10));
        GradientDrawable background=new GradientDrawable();background.setColor(primary?accent:paper);background.setCornerRadius(dp(28));
        button.setBackground(background);button.setTextColor(primary?Color.WHITE:accent);return button;
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private void complete(){preferences.edit().putBoolean("completed",true).apply();finish();}
    @Override public void onBackPressed(){if(step>0){step--;render();}else complete();}
    @Override protected void onDestroy(){super.onDestroy();AppGuide.presenting=false;}
    @Override protected void onSaveInstanceState(Bundle state){state.putInt("step",step);super.onSaveInstanceState(state);}
}
